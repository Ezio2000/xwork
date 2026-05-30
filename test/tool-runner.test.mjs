import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { release, type } from 'node:os';
import { spawnSync } from 'node:child_process';

import { runTool } from '../lib/tools/runner.mjs';
import { getEnabledToolDefinitions, listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { readToolConfigs, writeToolConfigs } from '../lib/tools/store.mjs';
import { loadBuiltinTools } from '../lib/tools/builtin/index.mjs';
import { shellCommandTool } from '../lib/tools/builtin/shell-command.mjs';
import { browserActionTool } from '../lib/tools/builtin/browser-action.mjs';
import { webFetchTool } from '../lib/tools/builtin/web-fetch.mjs';

function hasCommand(command) {
  const result = process.platform === 'win32' ? spawnSync('where', [command], {
    stdio: 'ignore',
  }) : spawnSync('sh', ['-c', `command -v ${command}`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

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
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const shell = tools.find(tool => tool.name === 'shell_command');

    assert.ok(shell);
    assert.equal(shell.dangerLevel, 'high');
    assert.equal(shellCommandTool.defaultEnabled, true);
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

  it('accepts absolute cwd paths that resolve to the workspace root with different casing', async () => {
    if (process.platform !== 'darwin') {
      return;
    }

    await withShellCommandEnabled(async () => {
      const alternateCaseCwd = process.cwd().replace('/AI/', '/ai/');
      const result = await runTool(
        { id: 'toolu_shell_case_cwd', name: 'shell_command', input: { command: 'pwd', cwd: alternateCaseCwd, maxOutputChars: 1000 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false, String(result.output || ''));
      assert.match(result.output.stdout, /xwork/);
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

  it('raises small maxOutputChars values instead of rejecting them', async () => {
    await withShellCommandEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_shell_small_output_budget', name: 'shell_command', input: { command: 'node -e "console.log(42)"', maxOutputChars: 500 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.output.exitCode, 0);
      assert.match(result.output.stdout, /42/);
    });
  });

  it('does not block PowerShell Format-* commands as disk format commands', { skip: process.platform !== 'win32' && !hasCommand('powershell') && !hasCommand('pwsh') }, async () => {
    await withShellCommandEnabled(async () => {
      const shell = hasCommand('powershell') ? 'powershell' : 'pwsh';
      const result = await runTool(
        { id: 'toolu_shell_format_table', name: 'shell_command', input: { command: `${shell} -Command "Get-Process -Id $PID | Format-Table -AutoSize"` } },
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

describe('tool configuration surface', () => {
  it('exposes delegate_task maxTurns as a per-call expert override but not global tool config', async () => {
    const tools = await listTools();
    const delegateTask = tools.find(tool => tool.id === 'delegate_task');

    assert.ok(delegateTask);
    assert.deepEqual(delegateTask.defaultConfig, { defaultMaxTurns: 3 });
    assert.equal(delegateTask.configSchema.properties.defaultMaxTurns.type, 'number');
    assert.equal(delegateTask.inputSchema.properties.maxTurns.type, 'number');
  });

  it('seeds current non-sensitive tool defaults for new installs', async () => {
    const tools = await listTools();
    const byId = Object.fromEntries(tools.map(tool => [tool.id, tool]));

    assert.equal(byId.web_search.defaultConfig.maxUses, 20);
    assert.equal(byId.web_fetch.defaultConfig.proxy, 'http://localhost:7890');
    assert.deepEqual(byId.delegate_task.defaultConfig, { defaultMaxTurns: 3 });
    assert.equal(byId.feishu_auth.defaultConfig.app_id, 'cli_a87b1a4b2bfc900b');
    assert.equal(byId.feishu_auth.defaultConfig.app_secret, '');
    assert.equal(byId.feishu_auth.defaultConfig.user_access_token, '');
    assert.equal(byId.feishu_auth.defaultConfig.refresh_token, '');
    assert.match(byId.feishu_auth.defaultConfig.oauthScope_user_authorized, /sheets:spreadsheet:read/);
    assert.equal(byId.feishu_read.defaultConfig.user_access_token, '');
  });

  it('exposes config metadata and applies server-tool config overrides', async () => {
    const tools = await listTools();
    const webSearch = tools.find(tool => tool.id === 'web_search');

    assert.ok(webSearch);
    assert.deepEqual(webSearch.defaultConfig, {
      maxUses: 20,
      allowedDomains: [],
      blockedDomains: [],
    });
    assert.equal(webSearch.configSchema.properties.maxUses.type, 'number');

    const previous = webSearch.config;
    try {
      const baseline = await updateToolConfig('web_search', {
        config: webSearch.defaultConfig,
      });
      assert.equal(baseline.config.maxUses, 20);
      assert.equal(baseline.maxUses, 20);

      const updated = await updateToolConfig('web_search', {
        config: {
          ...webSearch.defaultConfig,
          maxUses: 2,
          allowedDomains: ['example.com'],
          blockedDomains: [],
        },
      });
      assert.equal(updated.maxUses, 2);

      const enabled = await getEnabledToolDefinitions();
      const definition = enabled.find(tool => tool.name === 'web_search');
      assert.equal(definition.maxUses, 2);
      assert.deepEqual(definition.allowedDomains, ['example.com']);

      await updateToolConfig('web_search', {
        config: {
          ...webSearch.defaultConfig,
          maxUses: 'bad',
          allowedDomains: 'example.com',
        },
      });
      const fallbackDefinition = (await getEnabledToolDefinitions()).find(tool => tool.name === 'web_search');
      assert.equal(fallbackDefinition.maxUses, 20);
      assert.deepEqual(fallbackDefinition.allowedDomains, []);
    } finally {
      await updateToolConfig('web_search', { config: previous });
    }
  });

  it('uses a configurable 60s default timeout for web_search and migrates the old 10s default', async () => {
    const tools = await loadBuiltinTools();
    const previousConfigs = await readToolConfigs(tools);
    const previousWebSearch = previousConfigs.find(tool => tool.id === 'web_search');

    try {
      await writeToolConfigs(previousConfigs.map(config => (
        config.id === 'web_search'
          ? {
              ...config,
              timeoutMs: 10000,
              defaultTimeoutMs: 10000,
              config: {
                maxUses: 4,
                allowedDomains: [],
                blockedDomains: [],
              },
            }
          : config
      )));

      const migrated = await listTools();
      const webSearch = migrated.find(tool => tool.id === 'web_search');
      assert.equal(webSearch.timeoutMs, 60000);
      assert.equal(webSearch.defaultTimeoutMs, 60000);

      const custom = await updateToolConfig('web_search', { timeoutMs: 10000 });
      assert.equal(custom.timeoutMs, 10000);

      const reread = (await listTools()).find(tool => tool.id === 'web_search');
      assert.equal(reread.timeoutMs, 10000);
      assert.equal(reread.defaultTimeoutMs, 60000);
    } finally {
      if (previousWebSearch) {
        await writeToolConfigs(previousConfigs);
      }
    }
  });

  it('migrates the old delegate_task 125s default timeout to the longer expert budget', async () => {
    const tools = await loadBuiltinTools();
    const previousConfigs = await readToolConfigs(tools);
    const previousDelegateTask = previousConfigs.find(tool => tool.id === 'delegate_task');

    try {
      await writeToolConfigs(previousConfigs.map(config => (
        config.id === 'delegate_task'
          ? {
              ...config,
              timeoutMs: 125000,
              defaultTimeoutMs: 125000,
            }
          : config
      )));

      const migrated = await listTools();
      const delegateTask = migrated.find(tool => tool.id === 'delegate_task');
      assert.equal(delegateTask.timeoutMs, 305000);
      assert.equal(delegateTask.defaultTimeoutMs, 305000);

      const custom = await updateToolConfig('delegate_task', { timeoutMs: 125000 });
      assert.equal(custom.timeoutMs, 125000);

      const reread = (await listTools()).find(tool => tool.id === 'delegate_task');
      assert.equal(reread.timeoutMs, 125000);
      assert.equal(reread.defaultTimeoutMs, 305000);
    } finally {
      if (previousDelegateTask) {
        await writeToolConfigs(previousConfigs);
      }
    }
  });
});

describe('browser action tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const browser = tools.find(tool => tool.name === 'browser_action');

    assert.ok(browser);
    assert.equal(browser.dangerLevel, 'high');
    assert.equal(browserActionTool.defaultEnabled, true);
    assert.equal(browser.config.headless, true);
  });

  it('validates URL and host restrictions', () => {
    const url = browserActionTool.__test.validateHttpUrl('http://localhost:3000/');
    assert.equal(url.hostname, 'localhost');

    assert.doesNotThrow(() => browserActionTool.__test.assertAllowedUrl(url, { allowedHosts: ['localhost'] }));
    assert.throws(() => browserActionTool.__test.assertAllowedUrl(url, { allowedHosts: ['example.com'] }), /not allowed/i);
    assert.throws(() => browserActionTool.__test.assertAllowedUrl(url, { blockedHosts: ['localhost'] }), /Blocked/i);
    assert.throws(() => browserActionTool.__test.validateHttpUrl('file:///etc/passwd'), /http or https/);
  });

  it('sanitizes screenshot names and exposes render metadata', () => {
    assert.equal(browserActionTool.__test.screenshotFilename('home'), 'home.png');
    assert.equal(browserActionTool.__test.screenshotFilename('bilibili_search_黄仁勋.png'), 'bilibili_search.png');
    assert.equal(browserActionTool.__test.screenshotFilename('../bad'), 'bad.png');
    assert.equal(
      browserActionTool.__test.screenshotUrlFromPath('/workspace/data/browser-screenshots/home.png'),
      '/api/v1/tool-assets/browser-screenshots/home.png',
    );

    const render = browserActionTool.parseResult({
      action: 'locate',
      url: 'http://localhost:3000/',
      title: 'xwork',
      statusCode: 200,
      screenshotPath: '/workspace/data/browser-screenshots/home.png',
      screenshotUrl: '/api/v1/tool-assets/browser-screenshots/home.png',
      fullPage: true,
      count: 1,
      matches: [{ index: 0, tagName: 'button', text: 'Send' }],
    });

    assert.equal(render.renderType, 'browser-action');
    assert.equal(render.data.action, 'locate');
    assert.equal(render.data.title, 'xwork');
    assert.match(render.data.screenshotPath, /home\.png$/);
    assert.equal(render.data.screenshotUrl, '/api/v1/tool-assets/browser-screenshots/home.png');
    assert.deepEqual(render.data.matches, [{ index: 0, tagName: 'button', text: 'Send' }]);
  });

  it('keeps screenshots constrained to the current viewport box', () => {
    const tall = browserActionTool.__test.screenshotCapturePlan(
      { action: 'screenshot', fullPage: true },
      {},
      { viewportWidth: 1365, viewportHeight: 768, pageHeight: 85588 },
    );

    assert.equal(tall.metadata.fullPageRequested, true);
    assert.equal(tall.metadata.fullPage, false);
    assert.equal(tall.metadata.fullPageTruncated, true);
    assert.equal(tall.metadata.truncated, true);
    assert.equal(tall.metadata.pageHeight, 85588);
    assert.equal(tall.metadata.screenshotHeight, 768);
    assert.deepEqual(tall.options, { fullPage: false });

    const normal = browserActionTool.__test.screenshotCapturePlan(
      { action: 'screenshot', fullPage: true },
      {},
      { viewportWidth: 1365, viewportHeight: 768, pageHeight: 5000 },
    );
    assert.equal(normal.options.fullPage, false);
    assert.equal(normal.metadata.fullPage, false);
    assert.equal(normal.metadata.fullPageTruncated, true);
    assert.equal(normal.metadata.screenshotHeight, 768);

    const viewport = browserActionTool.__test.screenshotCapturePlan(
      { action: 'screenshot' },
      {},
      { viewportWidth: 1024, viewportHeight: 768, pageHeight: 5000 },
    );
    assert.deepEqual(viewport.options, { fullPage: false });
    assert.equal(viewport.metadata.fullPageRequested, false);
    assert.equal(viewport.metadata.fullPageTruncated, false);
    assert.equal(viewport.metadata.screenshotWidth, 1024);
    assert.equal(viewport.metadata.screenshotHeight, 768);
  });

  it('accepts visible text as a click or locate target', () => {
    assert.doesNotThrow(() => browserActionTool.validate({ action: 'click', text: '仙童数学' }));
    assert.doesNotThrow(() => browserActionTool.validate({ action: 'locate', text: '仙童数学' }));
    assert.throws(() => browserActionTool.validate({ action: 'click' }), /selector or text/);
    assert.throws(() => browserActionTool.validate({ action: 'locate' }), /selector or text/);

    const render = browserActionTool.parseResult({
      action: 'locate',
      url: 'https://www.bilibili.com/',
      title: 'bilibili',
      textQuery: '仙童数学',
      count: 1,
      matches: [{ index: 0, tagName: 'a', text: '仙童数学' }],
    });

    assert.equal(render.data.textQuery, '仙童数学');
    assert.equal(render.data.count, 1);
  });
});

describe('web fetch tool', () => {
  it('validates proxy configuration before attempting fetch', async () => {
    await assert.rejects(
      () => webFetchTool.handler(
        { url: 'https://example.com/' },
        { config: { proxy: 'httt://localhost:7890' } },
      ),
      /Invalid web_fetch proxy URL protocol: httt:/,
    );

    assert.equal(webFetchTool.defaultConfig.proxy, 'http://localhost:7890');
  });

  it('sniffs HTML content even when the response content type is wrong', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/json' }),
      async text() {
        return '<!DOCTYPE html><html><head><script>bad()</script></head><body><h1>Hello</h1><p>World</p></body></html>';
      },
    });

    try {
      const result = await webFetchTool.handler(
        { url: 'https://example.test/wrong-content-type-html' },
        { config: { proxy: '' } },
      );

      assert.match(result.markdown, /# Hello/);
      assert.match(result.markdown, /World/);
      assert.doesNotMatch(result.markdown, /<script|<!DOCTYPE|<html/i);
      assert.equal(result.contentType, 'application/json');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
