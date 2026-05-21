import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { release, type } from 'node:os';
import { spawnSync } from 'node:child_process';

import { runTool } from '../lib/tools/runner.mjs';
import { getEnabledToolDefinitions, listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { shellCommandTool } from '../lib/tools/builtin/shell-command.mjs';
import { browserActionTool } from '../lib/tools/builtin/browser-action.mjs';
import { mysqlQueryTool } from '../lib/tools/builtin/mysql-query.mjs';
import { sqliteQueryTool } from '../lib/tools/builtin/sqlite-query.mjs';

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
  it('exposes config metadata and applies server-tool config overrides', async () => {
    const tools = await listTools();
    const webSearch = tools.find(tool => tool.id === 'web_search');

    assert.ok(webSearch);
    assert.deepEqual(webSearch.defaultConfig, {
      maxUses: 4,
      allowedDomains: [],
      blockedDomains: [],
    });
    assert.equal(webSearch.config.maxUses, 4);
    assert.equal(webSearch.configSchema.properties.maxUses.type, 'number');

    const previous = webSearch.config;
    try {
      const updated = await updateToolConfig('web_search', {
        config: {
          ...previous,
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
          ...previous,
          maxUses: 'bad',
          allowedDomains: 'example.com',
        },
      });
      const fallbackDefinition = (await getEnabledToolDefinitions()).find(tool => tool.name === 'web_search');
      assert.equal(fallbackDefinition.maxUses, 4);
      assert.deepEqual(fallbackDefinition.allowedDomains, []);
    } finally {
      await updateToolConfig('web_search', { config: previous });
    }
  });
});

describe('browser action tool', () => {
  it('is registered but disabled by default', async () => {
    const tools = await listTools();
    const browser = tools.find(tool => tool.name === 'browser_action');

    assert.ok(browser);
    assert.equal(browser.dangerLevel, 'high');
    assert.equal(browserActionTool.defaultEnabled, false);
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

describe('mysql query tool', () => {
  it('is registered but disabled by default', async () => {
    const tools = await listTools();
    const mysql = tools.find(tool => tool.name === 'mysql_query');

    assert.ok(mysql);
    assert.equal(mysql.dangerLevel, 'high');
    assert.equal(mysqlQueryTool.defaultEnabled, false);
  });

  it('accepts multiple configured sources with host or ip', () => {
    const sources = mysqlQueryTool.__test.configuredSources({
      sources: [
        { id: 'dev', ip: '127.0.0.1', username: 'root', password: 'pw' },
        { id: 'uat', host: 'mysql.internal', port: 3307, username: 'app', password: 'pw', database: 'biz' },
      ],
    });

    assert.deepEqual(sources.map(source => source.id), ['dev', 'uat']);
    assert.equal(sources[0].host, '127.0.0.1');
    assert.equal(sources[0].port, 3306);
    assert.equal(sources[1].database, 'biz');
  });

  it('allows read-only SQL and blocks writes or multiple statements', () => {
    assert.doesNotThrow(() => mysqlQueryTool.__test.assertReadonlySql('select * from users limit 1'));
    assert.doesNotThrow(() => mysqlQueryTool.__test.assertReadonlySql('SHOW TABLES'));
    assert.doesNotThrow(() => mysqlQueryTool.__test.assertReadonlySql('WITH x AS (SELECT 1) SELECT * FROM x'));

    assert.throws(() => mysqlQueryTool.__test.assertReadonlySql('update users set name = 1'), /read-only/i);
    assert.throws(() => mysqlQueryTool.__test.assertReadonlySql('select * from users; drop table users'), /forbidden|multiple/i);
  });

  it('exposes a mysql query render block without leaking passwords', () => {
    const render = mysqlQueryTool.parseResult({
      source: { id: 'dev', host: '127.0.0.1', port: 3306, database: 'biz', user: 'root' },
      sql: 'select 1 as n',
      rowCount: 1,
      returnedRowCount: 1,
      truncated: false,
      columns: ['n'],
      rows: [{ n: 1 }],
    });

    assert.equal(render.renderType, 'mysql-query');
    assert.equal(render.data.source.id, 'dev');
    assert.equal(render.data.source.password, undefined);
    assert.deepEqual(render.data.previewRows, [{ n: 1 }]);
  });
});

describe('sqlite query tool', () => {
  it('is registered but disabled by default', async () => {
    const tools = await listTools();
    const sqlite = tools.find(tool => tool.name === 'sqlite_query');

    assert.ok(sqlite);
    assert.equal(sqlite.dangerLevel, 'medium');
    assert.equal(sqliteQueryTool.defaultEnabled, false);
  });

  it('accepts multiple configured sources inside the workspace', () => {
    const sources = sqliteQueryTool.__test.configuredSources({
      sources: [
        { id: 'xwork', path: 'data/xwork.sqlite' },
        { id: 'other', file: 'data/other.sqlite' },
      ],
    });

    assert.deepEqual(sources.map(source => source.id), ['xwork', 'other']);
    assert.match(sources[0].path, /xwork\.sqlite$/);
  });

  it('blocks writes and paths outside the workspace', () => {
    assert.doesNotThrow(() => sqliteQueryTool.__test.assertReadonlySql('select name from sqlite_master'));
    assert.doesNotThrow(() => sqliteQueryTool.__test.assertReadonlySql('pragma table_info(conversations)'));
    assert.throws(() => sqliteQueryTool.__test.assertReadonlySql('delete from conversations'), /read-only/i);
    assert.throws(() => sqliteQueryTool.__test.configuredSources({ sources: [{ id: 'bad', path: '..\\outside.sqlite' }] }), /workspace root/);
  });
});
