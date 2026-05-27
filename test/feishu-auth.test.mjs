import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTool } from '../lib/tools/runner.mjs';
import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { feishuAuthTool } from '../lib/tools/builtin/feishu-auth.mjs';
import { clearStoredUserTokens } from '../lib/feishu-auth.mjs';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    text: async () => JSON.stringify(payload),
  };
}

async function withFeishuAuthEnabled(config, fn) {
  const tools = await listTools();
  const currentAuth = tools.find(tool => tool.id === 'feishu_auth');
  const currentRead = tools.find(tool => tool.id === 'feishu_read');
  await updateToolConfig('feishu_auth', {
    enabled: true,
    timeoutMs: feishuAuthTool.timeoutMs,
    config: { ...feishuAuthTool.defaultConfig, ...config },
  });
  try {
    return await fn();
  } finally {
    try {
      await updateToolConfig('feishu_auth', {
        enabled: currentAuth?.enabled ?? false,
        timeoutMs: Math.min(Number(currentAuth?.timeoutMs) || feishuAuthTool.timeoutMs, feishuAuthTool.timeoutMs),
        config: currentAuth?.config || feishuAuthTool.defaultConfig,
      });
    } catch (err) {
      console.error('[feishu-auth test] failed to restore feishu_auth config:', err.message);
    }
    if (currentRead) {
      try {
        await updateToolConfig('feishu_read', {
          enabled: currentRead.enabled,
          timeoutMs: currentRead.timeoutMs,
          config: currentRead.config,
        });
      } catch (err) {
        console.error('[feishu-auth test] failed to restore feishu_read config:', err.message);
      }
    }
  }
}

describe('feishu_auth tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const tool = tools.find(item => item.id === 'feishu_auth');

    assert.ok(tool);
    assert.equal(tool.dangerLevel, 'low');
    assert.equal(feishuAuthTool.defaultEnabled, true);
    assert.equal(tool.defaultConfig.app_id, '');
    assert.equal(tool.defaultConfig.baseUrl, undefined);
    assert.equal(tool.defaultConfig.oauthScope, undefined);
    assert.equal(tool.configSchema.properties.app_secret.type, 'string');
  });

  it('starts device authorization without waiting', async () => {
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

    try {
      await withFeishuAuthEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_auth_start',
            name: 'feishu_auth',
            input: { action: 'start' },
          },
          { conversationId: 'test-convo', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.authorizationRequired, true);
        assert.equal(result.output.flow, 'device');
        assert.equal(result.output.deviceCode, 'device-code-1');
        assert.match(result.output.verificationUrl, /^https:\/\/accounts\.feishu\.cn\/oauth\/v1\/device\/verify/);
        assert.match(result.output.hint, /device-code-1/);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('starts device authorization with domain scopes', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/oauth\/v1\/device_authorization$/);
      const body = JSON.parse(options.body);
      assert.equal(body.client_id, 'cli_xxx');
      assert.match(body.scope, /auth:user\.id:read/);
      assert.match(body.scope, /docx:document:readonly/);
      assert.match(body.scope, /wiki:node:read/);
      return jsonResponse({
        device_code: 'device-code-1',
        expires_in: 600,
        interval: 5,
        verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-EFGH',
      });
    };

    try {
      await withFeishuAuthEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_auth_start_domains',
            name: 'feishu_auth',
            input: { action: 'start', domains: ['docs', 'wiki'] },
          },
          { conversationId: 'test-convo', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.deviceCode, 'device-code-1');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('logs in by opening authorization, polling, and saving token', async () => {
    const previousFetch = globalThis.fetch;
    const events = [];
    globalThis.fetch = async (url) => {
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
      throw new Error(`unexpected URL ${value}`);
    };

    try {
      await withFeishuAuthEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_auth_login',
            name: 'feishu_auth',
            input: { action: 'login' },
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
        assert.equal(result.output.authorizationRequired, false);
        assert.equal(events[0].phase, 'feishu_auth_pending');
        assert.equal(events[0].deviceCode, 'device-code-1');
        assert.equal(events[1].phase, 'feishu_auth_complete');
        const tools = await listTools();
        assert.equal(tools.find(item => item.id === 'feishu_auth').config.user_access_token, 'u-device-token');
        assert.notEqual(tools.find(item => item.id === 'feishu_read').config.user_access_token, 'u-device-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('completes device authorization with a device code', async () => {
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
      await withFeishuAuthEnabled({
        app_id: 'cli_xxx',
        app_secret: 'secret',
        user_access_token: '',
      }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_auth_complete',
            name: 'feishu_auth',
            input: { action: 'complete', deviceCode: 'device-code-1' },
          },
          { conversationId: 'test-convo', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.hasRefreshToken, true);
        const tool = (await listTools()).find(item => item.id === 'feishu_auth');
        assert.equal(tool.config.user_access_token, 'u-device-token');
        assert.equal(tool.config.refresh_token, 'refresh-device-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('clears stored user tokens without clearing app credentials', async () => {
    await withFeishuAuthEnabled({
      app_id: 'cli_keep',
      app_secret: 'secret_keep',
      user_access_token: 'u-token',
      userAccessToken: 'legacy-token',
      user_access_token_expires_at: '2026-05-26T00:00:00.000Z',
      refresh_token: 'refresh-token',
      refresh_token_expires_at: '2026-06-26T00:00:00.000Z',
    }, async () => {
      await updateToolConfig('feishu_read', {
        enabled: true,
        timeoutMs: 30000,
        config: {
          user_access_token: 'read-token',
          userAccessToken: 'legacy-read-token',
          refresh_token: 'read-refresh',
          defaultSheetRange: 'A1:B2',
        },
      });

      const result = await runTool(
        {
          id: 'toolu_feishu_auth_logout',
          name: 'feishu_auth',
          input: { action: 'logout' },
        },
        { conversationId: 'test-convo', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false, String(result.output || ''));
      const tool = (await listTools()).find(item => item.id === 'feishu_auth');
      assert.equal(tool.config.app_id, 'cli_keep');
      assert.equal(tool.config.app_secret, 'secret_keep');
      assert.equal(tool.config.user_access_token, '');
      assert.equal(tool.config.userAccessToken, undefined);
      assert.equal(tool.config.refresh_token, undefined);
      assert.equal(tool.config.refresh_token_expires_at, undefined);

      await updateToolConfig('feishu_read', {
        config: {
          user_access_token: 'read-token',
          userAccessToken: 'legacy-read-token',
          refresh_token: 'read-refresh',
          defaultSheetRange: 'A1:B2',
        },
      });
      await clearStoredUserTokens();
      const tools = await listTools();
      const readTool = tools.find(item => item.id === 'feishu_read');
      assert.equal(readTool.config.defaultSheetRange, 'A1:B2');
      assert.equal(readTool.config.user_access_token, '');
      assert.equal(readTool.config.userAccessToken, undefined);
      assert.equal(readTool.config.refresh_token, undefined);
    });
  });
});
