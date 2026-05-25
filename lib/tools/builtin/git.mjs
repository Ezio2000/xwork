import {
  DEFAULT_GIT_LOG_COUNT,
  DEFAULT_GIT_MAX_OUTPUT_CHARS,
  DEFAULT_GIT_TIMEOUT_MS,
  GIT_ACTIONS,
  MAX_GIT_MAX_OUTPUT_CHARS,
  MAX_GIT_TIMEOUT_MS,
  runGitAction,
  validateGitInput,
} from '../../git-workspace.mjs';

function configuredValue(config, key, fallback) {
  const value = config?.[key];
  return value === undefined ? fallback : value;
}

function configuredInteger(config, key, fallback, { min, max }) {
  const value = configuredValue(config, key, fallback);
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export const gitTool = {
  id: 'git',
  name: 'git',
  title: 'Git',
  description:
    'Read-only git inspection for the workspace repository. Actions: status, diff, log, show, branch, remote, blame, stash_list, reflog, tag. Use instead of shell_command for repository history and change inspection.',
  category: 'system',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
  systemPrompt() {
    return [
      '# git',
      '- Use for repository state/history instead of shell git when possible.',
      '- status: working tree summary. diff: unstaged/staged changes or compare refs. log/show: commit history and details.',
      '- branch/remote/tag: refs and remotes. blame: line authorship. stash_list/reflog: recovery context.',
      '- Narrow large diffs with paths, statOnly, or smaller maxCount before requesting full patches.',
    ].join('\n');
  },
  defaultConfig: {
    timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    maxOutputChars: DEFAULT_GIT_MAX_OUTPUT_CHARS,
    maxCount: DEFAULT_GIT_LOG_COUNT,
  },
  configSchema: {
    type: 'object',
    properties: {
      timeoutMs: {
        type: 'number',
        description: 'Default timeout for git commands.',
      },
      maxOutputChars: {
        type: 'number',
        description: 'Default combined stdout/stderr character budget.',
      },
      maxCount: {
        type: 'number',
        description: 'Default maxCount for log/reflog when omitted.',
      },
    },
    additionalProperties: false,
  },
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: `Git read-only action: ${[...GIT_ACTIONS].join(' | ')}`,
        enum: [...GIT_ACTIONS],
      },
      cwd: {
        type: 'string',
        description: 'Optional working directory inside the workspace. Defaults to workspace root.',
      },
      path: {
        type: 'string',
        description: 'For blame: workspace-relative file path.',
      },
      paths: {
        type: 'array',
        description: 'Optional path filters for diff/log.',
        items: { type: 'string' },
      },
      ref: {
        type: 'string',
        description: 'Commit/ref for show or diff target.',
      },
      baseRef: {
        type: 'string',
        description: 'Base ref for diff range comparisons (baseRef..ref).',
      },
      staged: {
        type: 'boolean',
        description: 'For diff: show staged changes (--cached).',
      },
      statOnly: {
        type: 'boolean',
        description: 'For diff/show: return stats only, omit patch body.',
      },
      patch: {
        type: 'boolean',
        description: 'For show: include patch body. Defaults to true unless statOnly is true.',
      },
      context: {
        type: 'number',
        description: 'For diff: unified context lines (0-5).',
      },
      maxCount: {
        type: 'number',
        description: 'For log/reflog/stash_list: maximum entries.',
      },
      since: {
        type: 'string',
        description: 'For log: relative date filter such as "2 weeks ago".',
      },
      grep: {
        type: 'string',
        description: 'For log: case-insensitive commit message search.',
      },
      author: {
        type: 'string',
        description: 'For log: author filter.',
      },
      format: {
        type: 'string',
        description: 'For log: oneline (default) or medium.',
        enum: ['oneline', 'medium'],
      },
      all: {
        type: 'boolean',
        description: 'For branch: include remote branches.',
      },
      merged: {
        type: 'boolean',
        description: 'For branch: only merged branches.',
      },
      noMerged: {
        type: 'boolean',
        description: 'For branch: only unmerged branches.',
      },
      contains: {
        type: 'string',
        description: 'For branch: branches containing this ref.',
      },
      pattern: {
        type: 'string',
        description: 'For tag: optional tag name pattern.',
      },
      startLine: {
        type: 'number',
        description: 'For blame: starting line number.',
      },
      endLine: {
        type: 'number',
        description: 'For blame: ending line number.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },

  validate(input) {
    validateGitInput(input);
  },

  async handler(input, { config: toolConfig = {} }) {
    return runGitAction(input, {
      timeoutMs: configuredInteger(toolConfig, 'timeoutMs', DEFAULT_GIT_TIMEOUT_MS, {
        min: 1000,
        max: MAX_GIT_TIMEOUT_MS,
      }),
      maxOutputChars: configuredInteger(toolConfig, 'maxOutputChars', DEFAULT_GIT_MAX_OUTPUT_CHARS, {
        min: 1000,
        max: MAX_GIT_MAX_OUTPUT_CHARS,
      }),
    });
  },

  parseResult(output) {
    return {
      renderType: 'git-output',
      data: {
        action: output.action,
        cwd: output.cwd,
        command: output.command,
        exitCode: output.exitCode,
        truncated: output.truncated,
        output: output.output,
        summary: output.summary,
      },
    };
  },
};
