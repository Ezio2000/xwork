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
  const currentAuth = tools.find(tool => tool.id === 'feishu_auth');
  await updateToolConfig('feishu_auth', {
    enabled: currentAuth?.enabled ?? false,
    timeoutMs: currentAuth?.timeoutMs ?? 300000,
    config: {},
  });
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
    await updateToolConfig('feishu_auth', {
      enabled: currentAuth?.enabled ?? false,
      timeoutMs: currentAuth?.timeoutMs ?? 300000,
      config: currentAuth?.config || {},
    });
    feishuReadTool.__test._resetTokenCache();
  }
}

async function withFeishuAuthConfig(config, fn) {
  const tools = await listTools();
  const current = tools.find(tool => tool.id === 'feishu_auth');
  await updateToolConfig('feishu_auth', {
    enabled: current?.enabled ?? false,
    timeoutMs: current?.timeoutMs ?? 300000,
    config: { ...(current?.config || {}), ...config },
  });
  try {
    return await fn();
  } finally {
    await updateToolConfig('feishu_auth', {
      enabled: current?.enabled ?? false,
      timeoutMs: current?.timeoutMs ?? 300000,
      config: current?.config || {},
    });
  }
}

describe('feishu_read tool', () => {
  it('is registered but disabled by default', async () => {
    const tools = await listTools();
    const tool = tools.find(item => item.id === 'feishu_read');

    assert.ok(tool);
    assert.equal(tool.dangerLevel, 'low');
    assert.equal(feishuReadTool.defaultEnabled, false);
    assert.equal(tool.defaultConfig.app_id, undefined);
    assert.equal(tool.defaultConfig.defaultSheetRange, 'A1:Z100');
    assert.equal(tool.configSchema.properties.app_secret, undefined);
    assert.equal(tool.configSchema.properties.maxTextChars.type, 'number');
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
    assert.deepEqual(
      feishuReadTool.__test.extractTokenFromUrl('https://example.feishu.cn/wiki/I6BQwED7mi3x1Ek0WimcNLSZnIh', 'wiki'),
      { wikiToken: 'I6BQwED7mi3x1Ek0WimcNLSZnIh', documentId: undefined, docToken: undefined, spreadsheetToken: undefined },
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

  it('resolves a wiki URL to its docx object and reads raw content', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
      if (path.includes('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (path.includes('/wiki/v2/spaces/get_node')) {
        return jsonResponse({
          code: 0,
          data: {
            node: {
              node_token: 'wiki_node_token',
              obj_token: 'docx_obj_token',
              obj_type: 'docx',
              title: 'Wiki Doc',
            },
          },
        });
      }
      if (path.includes('/docx/v1/documents/docx_obj_token/raw_content')) {
        return jsonResponse({ code: 0, data: { content: '# Wiki Doc\n\nBody' } });
      }
      throw new Error(`unexpected path ${path}`);
    };

    try {
      await withFeishuReadEnabled({ app_id: 'cli_xxx', app_secret: 'secret' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_wiki',
            name: 'feishu_read',
            input: {
              action: 'read_wiki',
              url: 'https://example.feishu.cn/wiki/wiki_node_token',
            },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.wikiToken, 'wiki_node_token');
        assert.equal(result.output.objToken, 'docx_obj_token');
        assert.equal(result.output.objType, 'docx');
        assert.match(result.output.content, /Wiki Doc/);
        assert.equal(calls[1].url.searchParams.get('token'), 'wiki_node_token');
        assert.match(calls[2].url.pathname, /docx_obj_token\/raw_content$/);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('authorizes wiki and docs scopes when tenant lacks wiki read permission', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    const events = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
      if (path.includes('/auth/v3/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 });
      }
      if (path.includes('/wiki/v2/spaces/get_node')) {
        if (options.headers.Authorization === 'Bearer tenant-token') {
          return jsonResponse({
            code: 99991668,
            msg: 'tenant needs read permission',
          });
        }
        assert.equal(options.headers.Authorization, 'Bearer u-doc-token');
        return jsonResponse({
          code: 0,
          data: {
            node: {
              node_token: 'wiki_node_token',
              obj_token: 'docx_obj_token',
              obj_type: 'docx',
              title: 'Wiki Doc',
            },
          },
        });
      }
      if (path.includes('/oauth/v1/device_authorization')) {
        const body = JSON.parse(options.body);
        assert.match(body.scope, /auth:user\.id:read/);
        assert.match(body.scope, /wiki:wiki:readonly/);
        assert.match(body.scope, /wiki:node:read/);
        return jsonResponse({
          device_code: 'device-code-1',
          expires_in: 600,
          interval: 2,
          verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-EFGH',
        });
      }
      if (path.includes('/open-apis/authen/v2/oauth/token')) {
        return jsonResponse({
          access_token: 'u-doc-token',
          expires_in: 7200,
        });
      }
      if (path.includes('/docx/v1/documents/docx_obj_token/raw_content')) {
        assert.equal(options.headers.Authorization, 'Bearer u-doc-token');
        return jsonResponse({ code: 0, data: { content: '# Wiki Doc\n\nBody' } });
      }
      throw new Error(`unexpected path ${path}`);
    };

    try {
      await withFeishuReadEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_wiki_auth',
            name: 'feishu_read',
            input: {
              action: 'read_wiki',
              url: 'https://example.feishu.cn/wiki/wiki_node_token',
            },
          },
          {
            conversationId: 'test',
            source: 'test',
            environment: 'test',
            persistToolRun: false,
            emitToolEvent: event => events.push(event),
          },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.objToken, 'docx_obj_token');
        assert.match(result.output.content, /Wiki Doc/);
        assert.equal(events[0].phase, 'feishu_auth_pending');
        assert.equal(events[0].action, 'get_wiki_node');
        assert.equal(events[1].phase, 'feishu_auth_complete');
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

  it('uses the token saved by feishu_auth over a stale feishu_read token', async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      assert.equal(options.headers.Authorization, 'Bearer u-auth-current');
      return jsonResponse({
        code: 0,
        data: {
          open_id: 'ou_current',
          user_id: 'current_user',
          name: 'Current User',
        },
      });
    };

    try {
      await withFeishuReadEnabled({ user_access_token: 'bad-token' }, async () => {
        await withFeishuAuthConfig({ user_access_token: 'u-auth-current' }, async () => {
          const result = await runTool(
            {
              id: 'toolu_feishu_current_user_auth_token',
              name: 'feishu_read',
              input: { action: 'get_current_user' },
            },
            { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
          );

          assert.equal(result.isError, false, String(result.output || ''));
          assert.equal(result.output.user.name, 'Current User');
          assert.equal(calls.length, 1);
        });
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('starts device authorization explicitly', async () => {
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
            input: { action: 'authorize_current_user' },
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

  it('auto-opens device authorization, waits, saves token, and returns current user', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async (url, options) => {
      const value = String(url);
      if (value.includes('/oauth/v1/device_authorization')) {
        return jsonResponse({
          device_code: 'device-code-1',
          expires_in: 600,
          interval: 2,
          verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-EFGH',
        });
      }
      if (value.includes('/open-apis/authen/v2/oauth/token')) {
        return jsonResponse({
          access_token: 'u-device-token',
          expires_in: 7200,
          refresh_token: 'refresh-device-token',
          refresh_expires_in: 2592000,
        });
      }
      if (value.includes('/open-apis/authen/v1/user_info')) {
        assert.equal(options.headers.Authorization, 'Bearer u-device-token');
        return jsonResponse({
          code: 0,
          data: {
            open_id: 'ou_current',
            user_id: 'current_user',
            name: 'Current User',
          },
        });
      }
      throw new Error(`unexpected URL ${value}`);
    };

    try {
      await withFeishuReadEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_auto_auth',
            name: 'feishu_read',
            input: { action: 'get_current_user' },
          },
          {
            conversationId: 'test-convo',
            source: 'test',
            environment: 'test',
            persistToolRun: false,
            emitToolEvent: event => events.push(event),
          },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.user.name, 'Current User');
        assert.equal(events[0].phase, 'feishu_auth_pending');
        assert.equal(events[0].deviceCode, 'device-code-1');
        assert.equal(events[1].phase, 'feishu_auth_complete');
        const tools = await listTools();
        assert.notEqual(tools.find(item => item.id === 'feishu_read').config.user_access_token, 'u-device-token');
        assert.equal(tools.find(item => item.id === 'feishu_auth').config.user_access_token, 'u-device-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('starts device authorization when configured user token is invalid', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    let userInfoCalls = 0;
    globalThis.fetch = async (url, options) => {
      const value = String(url);
      if (value.includes('/open-apis/authen/v1/user_info')) {
        userInfoCalls += 1;
        if (userInfoCalls === 1) {
          assert.equal(options.headers.Authorization, 'Bearer bad-token');
          return jsonResponse({
            code: 99991663,
            msg: 'invalid access_token',
          });
        }
        assert.equal(options.headers.Authorization, 'Bearer u-device-token');
        return jsonResponse({
          code: 0,
          data: {
            open_id: 'ou_current',
            user_id: 'current_user',
            name: 'Current User',
          },
        });
      }
      if (value.includes('/oauth/v1/device_authorization')) {
        return jsonResponse({
          device_code: 'device-code-1',
          expires_in: 600,
          interval: 2,
          verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-EFGH',
        });
      }
      if (value.includes('/open-apis/authen/v2/oauth/token')) {
        return jsonResponse({
          access_token: 'u-device-token',
          expires_in: 7200,
        });
      }
      throw new Error(`unexpected URL ${value}`);
    };

    try {
      await withFeishuReadEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: 'bad-token',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_invalid_token_auth',
            name: 'feishu_read',
            input: { action: 'get_current_user' },
          },
          {
            conversationId: 'test-convo',
            source: 'test',
            environment: 'test',
            persistToolRun: false,
            emitToolEvent: event => events.push(event),
          },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.user.name, 'Current User');
        assert.equal(events[0].phase, 'feishu_auth_pending');
        assert.equal(events[1].phase, 'feishu_auth_complete');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
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
        assert.equal(result.output.hasRefreshToken, true);
        const tools = await listTools();
        const authTool = tools.find(item => item.id === 'feishu_auth');
        assert.equal(authTool.config.user_access_token, 'u-device-token');
        assert.equal(authTool.config.refresh_token, 'refresh-device-token');
        assert.notEqual(tools.find(item => item.id === 'feishu_read').config.user_access_token, 'u-device-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
