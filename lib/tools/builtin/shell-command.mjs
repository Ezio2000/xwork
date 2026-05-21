import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { release, type } from 'node:os';
import { resolve, relative, isAbsolute } from 'node:path';

const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_OUTPUT_ENCODING = process.platform === 'win32' ? 'gb18030' : 'utf-8';
const MAX_COMMAND_LENGTH = 4000;
const MAX_CWD_LENGTH = 500;
const MAX_OUTPUT_CHARS = 100_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;
const SUPPORTED_OUTPUT_ENCODINGS = new Set(['utf-8', 'utf8', 'gb18030', 'gbk', 'big5']);

const WORKSPACE_ROOT = resolve(process.cwd());
const OS_CONTEXT = `${type()} ${release()} (${process.platform})`;
const DEFAULT_SHELL = process.platform === 'win32'
  ? 'Windows shell (cmd.exe by default; PowerShell commands are available when invoked through powershell)'
  : 'POSIX shell (/bin/sh by default)';

const dangerousPatterns = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[fsq]/i,
  /(?:^|[;&|]\s*)format(?:\s|$)/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bstop-computer\b/i,
  /\bremove-item\b[\s\S]*\b-recurse\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[^\s]*f/i,
];

function clampInteger(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function ensureString(value, name, max) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  if (value.length > max) {
    throw new Error(`${name} is too long`);
  }
}

function resolveWorkspacePath(cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return WORKSPACE_ROOT;
  ensureString(cwd, 'cwd', MAX_CWD_LENGTH);

  const resolved = isAbsolute(cwd)
    ? resolve(cwd)
    : resolve(WORKSPACE_ROOT, cwd);
  const rel = relative(WORKSPACE_ROOT, resolved);
  if (rel === '..' || rel.startsWith(`..\\`) || rel.startsWith('../') || isAbsolute(rel)) {
    throw new Error('cwd must stay inside the workspace root');
  }
  if (!existsSync(resolved)) {
    throw new Error('cwd does not exist');
  }
  return resolved;
}

function rejectDangerousCommand(command) {
  for (const pattern of dangerousPatterns) {
    if (pattern.test(command)) {
      throw new Error('command blocked by shell safety policy');
    }
  }
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} chars]`,
    truncated: true,
  };
}

function safeDecoder(encoding) {
  const normalized = String(encoding || DEFAULT_OUTPUT_ENCODING).toLowerCase();
  const selected = SUPPORTED_OUTPUT_ENCODINGS.has(normalized) ? normalized : DEFAULT_OUTPUT_ENCODING;
  try {
    return new TextDecoder(selected === 'utf8' ? 'utf-8' : selected);
  } catch {
    return new TextDecoder('utf-8');
  }
}

function decodeOutput(chunks, encoding) {
  const buffer = Buffer.concat(chunks);
  if (buffer.length === 0) return '';

  const primary = safeDecoder(encoding).decode(buffer);
  if (encoding !== 'utf-8' && primary.includes('�')) {
    const utf8 = safeDecoder('utf-8').decode(buffer);
    if ((utf8.match(/�/g) || []).length < (primary.match(/�/g) || []).length) return utf8;
  }
  return primary;
}

function killProcess(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, 1000).unref?.();
}

export const shellCommandTool = {
  id: 'shell_command',
  name: 'shell_command',
  title: 'Shell Command',
  description: `Run a bounded shell command in the workspace. Current operating system: ${OS_CONTEXT}. Default shell: ${DEFAULT_SHELL}. Use for read-only inspection, tests, builds, and local diagnostics. Commands run inside the project workspace, have a timeout, and return truncated stdout/stderr.`,
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'high',
  defaultEnabled: false,
  timeoutMs: 125000,
  defaultConfig: {
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    outputEncoding: DEFAULT_OUTPUT_ENCODING,
  },
  configSchema: {
    type: 'object',
    properties: {
      commandTimeoutMs: {
        type: 'number',
        description: 'Default timeout for an individual command when the tool input does not override it.',
      },
      maxOutputChars: {
        type: 'number',
        description: 'Default combined stdout/stderr character budget when the tool input does not override it.',
      },
      outputEncoding: {
        type: 'string',
        description: 'Default output decoder. Supported: utf-8, gb18030, gbk, big5.',
        enum: ['utf-8', 'gb18030', 'gbk', 'big5'],
      },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Longer test/build commands on Windows',
      config: {
        commandTimeoutMs: 60000,
        maxOutputChars: 50000,
        outputEncoding: 'gb18030',
      },
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: `Command to run in the workspace shell. Current operating system: ${OS_CONTEXT}. Default shell: ${DEFAULT_SHELL}. Prefer read-only commands and explicit paths.`,
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory, relative to the workspace root. Absolute paths are allowed only when they stay inside the workspace.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional command timeout in milliseconds. Default 20000, maximum 120000.',
      },
      maxOutputChars: {
        type: 'number',
        description: 'Optional combined stdout/stderr character budget. Default 20000, maximum 100000.',
      },
      outputEncoding: {
        type: 'string',
        description: 'Optional output decoding. Defaults to gb18030 on Windows and utf-8 elsewhere. Supported: utf-8, gb18030, gbk, big5.',
        enum: ['utf-8', 'gb18030', 'gbk', 'big5'],
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  validate(input) {
    ensureString(input.command, 'command', MAX_COMMAND_LENGTH);
    if (input.cwd !== undefined) ensureString(input.cwd, 'cwd', MAX_CWD_LENGTH);
    if (input.timeoutMs !== undefined) {
      const n = Number(input.timeoutMs);
      if (!Number.isInteger(n) || n < 1000 || n > MAX_COMMAND_TIMEOUT_MS) {
        throw new Error(`timeoutMs must be an integer between 1000 and ${MAX_COMMAND_TIMEOUT_MS}`);
      }
    }
    if (input.maxOutputChars !== undefined) {
      const n = Number(input.maxOutputChars);
      if (!Number.isInteger(n) || n < 1000 || n > MAX_OUTPUT_CHARS) {
        throw new Error(`maxOutputChars must be an integer between 1000 and ${MAX_OUTPUT_CHARS}`);
      }
    }
    if (input.outputEncoding !== undefined && !SUPPORTED_OUTPUT_ENCODINGS.has(String(input.outputEncoding).toLowerCase())) {
      throw new Error('outputEncoding must be one of utf-8, gb18030, gbk, big5');
    }
    rejectDangerousCommand(input.command);
    resolveWorkspacePath(input.cwd);
  },

  async before(input, { config }) {
    const timeoutMs = clampInteger(
      input.timeoutMs ?? config.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      1000,
      MAX_COMMAND_TIMEOUT_MS,
    );
    const maxOutputChars = clampInteger(
      input.maxOutputChars ?? config.maxOutputChars,
      DEFAULT_MAX_OUTPUT_CHARS,
      1000,
      MAX_OUTPUT_CHARS,
    );
    return {
      command: input.command.trim(),
      cwd: resolveWorkspacePath(input.cwd),
      timeoutMs,
      maxOutputChars,
      outputEncoding: input.outputEncoding || config.outputEncoding || DEFAULT_OUTPUT_ENCODING,
    };
  },

  async handler(input, { signal }) {
    return new Promise((resolvePromise, reject) => {
      const startedAt = Date.now();
      const stdoutChunks = [];
      const stderrChunks = [];
      let settled = false;
      let timedOut = false;

      const child = spawn(input.command, {
        cwd: input.cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
      });

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        resolvePromise(result);
      };

      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        reject(err);
      };

      const onAbort = () => {
        killProcess(child);
        fail(new Error('Shell command aborted'));
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcess(child);
      }, input.timeoutMs);

      signal?.addEventListener?.('abort', onAbort, { once: true });

      child.stdout?.on('data', chunk => {
        stdoutChunks.push(Buffer.from(chunk));
      });
      child.stderr?.on('data', chunk => {
        stderrChunks.push(Buffer.from(chunk));
      });
      child.on('error', fail);
      child.on('close', (code, closeSignal) => {
        const stdout = decodeOutput(stdoutChunks, input.outputEncoding);
        const stderr = decodeOutput(stderrChunks, input.outputEncoding);
        const stdoutResult = truncateText(stdout, input.maxOutputChars);
        const stderrBudget = Math.max(1000, input.maxOutputChars - stdoutResult.text.length);
        const stderrResult = truncateText(stderr, stderrBudget);
        finish({
          command: input.command,
          cwd: input.cwd,
          exitCode: code,
          signal: closeSignal,
          timedOut,
          durationMs: Date.now() - startedAt,
          stdout: stdoutResult.text,
          stderr: stderrResult.text,
          truncated: stdoutResult.truncated || stderrResult.truncated,
        });
      });
    });
  },

  parseResult(output) {
    return {
      renderType: 'shell-command',
      data: {
        command: output.command,
        cwd: output.cwd,
        exitCode: output.exitCode,
        signal: output.signal,
        timedOut: output.timedOut,
        durationMs: output.durationMs,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
      },
    };
  },
};
