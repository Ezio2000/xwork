import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { release, type } from 'node:os';

import { runTool } from '../lib/tools/runner.mjs';
import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { shellCommandTool } from '../lib/tools/builtin/shell-command.mjs';

async function withShellCommandEnabled(fn) {
  const tools = await listTools();
  const current = tools.find(tool => tool.id === 'shell_command');
  await updateToolConfig('shell_command', { enabled: true, timeoutMs: 5000 });
  try {
    return await fn();
  } finally {
    await updateToolConfig('shell_command', {
      enabled: current?.enabled ?? false,
      timeoutMs: current?.timeoutMs ?? shellCommandTool.timeoutMs,
    });
  }
}

describe('tool runner abort support', () => {
  it('returns an error result when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    const result = await runTool(
      { id: 'toolu_abort', name: 'calculator', input: { expression: '1 + 1' } },
      { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false, signal: ac.signal },
    );

    assert.equal(result.isError, true);
    assert.match(String(result.output), /aborted/i);
  });
});

describe('shell command tool', () => {
  it('is registered but disabled by default', async () => {
    const tools = await listTools();
    const shell = tools.find(tool => tool.name === 'shell_command');

    assert.ok(shell);
    assert.equal(shell.dangerLevel, 'high');
    assert.equal(shellCommandTool.defaultEnabled, false);
  });

  it('includes current operating system context in the model prompt text', () => {
    const osContext = `${type()} ${release()} (${process.platform})`;

    assert.match(shellCommandTool.description, new RegExp(osContext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(shellCommandTool.inputSchema.properties.command.description, new RegExp(osContext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('runs a bounded command when enabled', async () => {
    await withShellCommandEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_shell_ok', name: 'shell_command', input: { command: 'node -e "console.log(40 + 2)"' } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.output.exitCode, 0);
      assert.match(result.output.stdout, /42/);
      assert.equal(result.render.renderType, 'shell-command');
    });
  });

  it('rejects cwd outside the workspace', async () => {
    await withShellCommandEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_shell_cwd', name: 'shell_command', input: { command: 'node -v', cwd: '..' } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, true);
      assert.match(String(result.output), /workspace root/);
    });
  });

  it('blocks clearly destructive commands', async () => {
    await withShellCommandEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_shell_blocked', name: 'shell_command', input: { command: 'git reset --hard HEAD' } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, true);
      assert.match(String(result.output), /safety policy/);
    });
  });

  it('does not block PowerShell Format-* commands as disk format commands', async () => {
    await withShellCommandEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_shell_format_table', name: 'shell_command', input: { command: 'powershell -Command "Get-Process -Id $PID | Format-Table -AutoSize"' } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.output.exitCode, 0);
    });
  });

  it('decodes Windows shell output without mojibake by default', async () => {
    if (process.platform !== 'win32') return;

    await withShellCommandEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_shell_encoding', name: 'shell_command', input: { command: 'powershell -Command "Write-Error \'路径不存在\'"', maxOutputChars: 5000 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.output.exitCode, 1);
      assert.match(result.output.stderr, /路径不存在/);
      assert.doesNotMatch(result.output.stderr, /�/);
    });
  });
});
