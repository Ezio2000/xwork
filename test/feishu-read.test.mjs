import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTool } from '../lib/tools/runner.mjs';
import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { feishuReadTool } from '../lib/tools/builtin/feishu-read.mjs';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(payload),
  };
}

async function withFeishuReadEnabled(config, fn) {
  const tools = await listTools();
  const current = tools.find(tool => tool.id === 'feishu_read');
  await updateToolConfig('feishu_read', {
    enabled: true,
    timeoutMs: feishuReadTool.timeoutMs,
    config: { ...(current?.config || {}), ...config },
  });
  try {
    return await fn();
  } finally {
    await updateToolConfig('feishu_read', {
      enabled: current?.enabled ?? false,
      timeoutMs: current?.timeoutMs ?? feishuReadTool.timeoutMs,
      config: current?.config || feishuReadTool.defaultConfig,
    });
    feishuReadTool.__test._resetTokenCache();
  }
}

describe('feishu_read tool', () => {
  it('is registered but disabled by default', async () => {
    const tools = await listTools();
    const tool = tools.find(item => item.id === 'feishu_read');

    assert.ok(tool);
    assert.equal(tool.dangerLevel, 'low');
    assert.equal(feishuReadTool.defaultEnabled, false);
    assert.equal(tool.defaultConfig.app_id, '');
    assert.equal(tool.configSchema.properties.app_secret.type, 'string');
  });

  it('extracts tokens from Feishu document and sheet URLs', () => {
    assert.deepEqual(
      feishuReadTool.__test.extractTokenFromUrl('https://example.feishu.cn/docx/AbCdEfGhIjKl', 'doc'),
      { documentId: 'AbCdEfGhIjKl', wikiToken: undefined },
    );
    assert.deepEqual(
      feishuReadTool.__test.extractTokenFromUrl('https://example.feishu.cn/sheets/shtcnToken?sheet=abc123', 'sheet'),
      { spreadsheetToken: 'shtcnToken', sheetId: 'abc123' },
    );
  });

  it('reads docx raw content with tenant credentials', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      return jsonResponse({ code: 0, data: { content: '# Title\n\nBody' } });
    };

    try {
      await withFeishuReadEnabled({ appId: 'cli_xxx', appSecret: 'secret' }, async () => {
        const result = await runTool(
          { id: 'toolu_feishu_doc', name: 'feishu_read', input: { action: 'read_doc', documentId: 'docx_token' } },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.documentId, 'docx_token');
        assert.match(result.output.content, /Title/);
        assert.equal(result.render.renderType, 'file-snippet');
        assert.match(calls[0].url, /tenant_access_token\/internal/);
        assert.match(calls[1].url, /\/docx\/v1\/documents\/docx_token\/raw_content/);
        assert.equal(calls[1].options.headers.Authorization, 'Bearer tenant-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reads spreadsheet ranges with a direct access token', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      return jsonResponse({
        code: 0,
        data: {
          revision: 3,
          valueRanges: [{
            range: 'sheet1!A1:B2',
            majorDimension: 'ROWS',
            values: [
              ['Name', 'Score'],
              ['Alice', 42],
            ],
          }],
        },
      });
    };

    try {
      await withFeishuReadEnabled({ accessToken: 'direct-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_sheet',
            name: 'feishu_read',
            input: {
              action: 'read_sheet',
              spreadsheetToken: 'spreadsheet_token',
              ranges: ['sheet1!A1:B2'],
            },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.returnedCells, 4);
        assert.match(result.output.content, /Name\tScore/);
        assert.match(result.output.content, /Alice\t42/);
        assert.equal(calls.length, 1);
        assert.match(calls[0].url.pathname, /values_batch_get$/);
        assert.equal(calls[0].url.searchParams.get('ranges'), 'sheet1!A1:B2');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer direct-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('gets Feishu user info with user id type options', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      return jsonResponse({
        code: 0,
        data: {
          user: {
            user_id: 'ou_user',
            name: 'Alice',
            email: 'alice@example.test',
            department_ids: ['od_dept'],
          },
        },
      });
    };

    try {
      await withFeishuReadEnabled({ accessToken: 'direct-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_user',
            name: 'feishu_read',
            input: {
              action: 'get_user',
              userId: 'ou_user',
              userIdType: 'open_id',
              departmentIdType: 'open_department_id',
            },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.user.name, 'Alice');
        assert.match(calls[0].url.pathname, /\/contact\/v3\/users\/ou_user$/);
        assert.equal(calls[0].url.searchParams.get('user_id_type'), 'open_id');
        assert.equal(calls[0].url.searchParams.get('department_id_type'), 'open_department_id');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer direct-token');
        assert.equal(result.render.renderType, 'file-snippet');
        assert.match(result.render.data.content, /Alice/);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('gets current authorized Feishu user without requiring a user id', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      return jsonResponse({
        code: 0,
        data: {
          open_id: 'ou_current',
          union_id: 'on_current',
          user_id: 'current_user',
          name: 'Current User',
          email: 'current@example.test',
        },
      });
    };

    try {
      await withFeishuReadEnabled({ user_access_token: 'u-current' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_current_user',
            name: 'feishu_read',
            input: { action: 'get_current_user' },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.user.name, 'Current User');
        assert.match(calls[0].url.pathname, /\/authen\/v1\/user_info$/);
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-current');
        assert.match(result.render.data.content, /Current User/);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('returns an authorization URL when current user token is missing', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/oauth\/v1\/device_authorization$/);
      const body = JSON.parse(options.body);
      assert.equal(body.client_id, 'cli_xxx');
      assert.equal(body.client_secret, 'secret');
      assert.equal(body.scope, 'auth:user.id:read');
      return jsonResponse({
        device_code: 'device-code-1',
        expires_in: 600,
        interval: 5,
        verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-EFGH',
      });
    };

    await withFeishuReadEnabled({
      app_id: 'cli_xxx',
      app_secret: 'secret',
      user_access_token: '',
    }, async () => {
      const result = await runTool(
        {
          id: 'toolu_feishu_authorize',
          name: 'feishu_read',
          input: { action: 'get_current_user' },
        },
        { conversationId: 'test-convo', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false, String(result.output || ''));
      assert.equal(result.output.authorizationRequired, true);
      assert.equal(result.output.flow, 'device');
      assert.equal(result.output.deviceCode, 'device-code-1');
      assert.match(result.output.verificationUrl, /^https:\/\/accounts\.feishu\.cn\/oauth\/v1\/device\/verify/);
      assert.match(result.render.data.content, /authorizationUrl/);
    });
    globalThis.fetch = previousFetch;
  });

  it('completes device authorization and saves the user access token', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/open-apis\/authen\/v2\/oauth\/token$/);
      const body = JSON.parse(options.body);
      assert.equal(body.grant_type, 'urn:ietf:params:oauth:grant-type:device_code');
      assert.equal(body.device_code, 'device-code-1');
      return jsonResponse({
        access_token: 'u-device-token',
        expires_in: 7200,
        refresh_token: 'refresh-device-token',
        refresh_expires_in: 2592000,
      });
    };

    try {
      await withFeishuReadEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_complete_auth',
            name: 'feishu_read',
            input: { action: 'complete_current_user_authorization', deviceCode: 'device-code-1' },
          },
          { conversationId: 'test-convo', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.userAccessToken, 'u-device-token');
        const tool = (await listTools()).find(item => item.id === 'feishu_read');
        assert.equal(tool.config.user_access_token, 'u-device-token');
        assert.equal(tool.config.refresh_token, 'refresh-device-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
