import {
  clearUserToken,
  completeDeviceAuthorization,
  configWithOAuthScopes,
  getUserAccessToken,
  loadFeishuAuthConfig,
  scopesFromAuthInput,
  startDeviceAuthorization,
  authorizeAndWait,
} from '../../feishu-auth.mjs';

const ACTIONS = new Set(['login', 'start', 'complete', 'status', 'logout']);

function tokenStatus(config) {
  let hasUserAccessToken = false;
  try {
    hasUserAccessToken = Boolean(getUserAccessToken(config));
  } catch {
    hasUserAccessToken = false;
  }
  return {
    action: 'status',
    resourceType: 'authorization',
    authorizationRequired: !hasUserAccessToken,
    hasUserAccessToken,
    userAccessTokenExpiresAt: config.user_access_token_expires_at || '',
    hasRefreshToken: Boolean(config.refresh_token),
    refreshTokenExpiresAt: config.refresh_token_expires_at || '',
    message: hasUserAccessToken
      ? 'Feishu user_access_token is configured.'
      : 'Feishu user_access_token is not configured. Use action="login" to authorize.',
  };
}

export const tool = {
  id: 'feishu_auth',
  name: 'feishu_auth',
  title: 'Feishu Auth',
  description: [
    'Authorize the current Feishu/Lark user using Device Flow, modeled after lark-cli auth login.',
    '',
    'Actions:',
    '- login: start Device Flow, emit an authorization popup event, wait until the user approves, then save user_access_token. Optional domain/domains can request docs, wiki, sheets, or contact scopes.',
    '- start: like lark-cli auth login --no-wait; return deviceCode and verificationUrl without polling.',
    '- complete: like lark-cli auth login --device-code; exchange deviceCode and save user_access_token.',
    '- status: report whether a user token is configured.',
    '- logout: clear the stored user token for Feishu tools.',
  ].join('\n'),
  category: 'web',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'low',
  defaultEnabled: true,
  timeoutMs: 300000,
  systemPrompt() {
    return [
      '# feishu_auth',
      '- Use feishu_auth action="login" when the user explicitly asks to authorize, login, reconnect, or refresh Feishu access.',
      '- login opens a Feishu authorization popup through tool events and keeps polling until the user approves or the flow expires.',
      '- Use action="start" only when a no-wait Device Flow is explicitly needed; then use action="complete" with deviceCode.',
      '- Do not ask the user to run lark-cli or configure a redirect URL. This tool implements the same Device Flow style directly.',
    ].join('\n');
  },
  defaultConfig: {
    app_id: 'cli_a87b1a4b2bfc900b',
    app_secret: '',
    user_access_token: '',
    user_access_token_expires_at: '',
    refresh_token: '',
    refresh_token_expires_at: '',
    oauthScope_user_authorized: 'auth:user.id:read wiki:wiki:readonly wiki:node:read docx:document:readonly space:document:retrieve sheets:spreadsheet:read sheets:spreadsheet.meta:read',
  },
  configSchema: {
    type: 'object',
    properties: {
      baseUrl: { type: 'string', description: 'Feishu/Lark OpenAPI base URL. Defaults to https://open.feishu.cn.' },
      authBaseUrl: { type: 'string', description: 'Feishu/Lark Device Flow base URL. Defaults to https://accounts.feishu.cn.' },
      app_id: { type: 'string', description: 'Feishu app_id used as OAuth client_id.' },
      app_secret: { type: 'string', description: 'Feishu app_secret used as OAuth client_secret.' },
      user_access_token: { type: 'string', description: 'Stored user_access_token. Normally written by action="login" or action="complete".' },
      user_access_token_expires_at: { type: 'string', description: 'Stored user access token expiration timestamp.' },
      refresh_token: { type: 'string', description: 'Stored Feishu refresh token.' },
      refresh_token_expires_at: { type: 'string', description: 'Stored refresh token expiration timestamp.' },
      oauthScope: { type: 'string', description: 'OAuth scopes requested for Device Flow. Defaults to auth:user.id:read.' },
      oauthScope_user_authorized: { type: 'string', description: 'OAuth scopes previously authorized by the current user.' },
    },
    additionalProperties: false,
  },
  configExamples: [
    {
      title: 'Device Flow',
      config: {
        app_id: 'cli_xxx',
        app_secret: 'xxx',
      },
    },
  ],
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Operation to perform: login, start, complete, status, or logout.',
      },
      deviceCode: {
        type: 'string',
        description: 'Device Flow device_code returned by action="start". Required for action="complete".',
      },
      device_code: {
        type: 'string',
        description: 'Alias of deviceCode.',
      },
      scope: {
        type: 'string',
        description: 'Additional OAuth scopes, space-separated. Example: "wiki:wiki:readonly wiki:node:read".',
      },
      scopes: {
        type: 'array',
        description: 'Additional OAuth scopes.',
        items: { type: 'string' },
      },
      domain: {
        type: 'string',
        description: 'Convenience domain scope set: docs, wiki, sheets, or contact.',
      },
      domains: {
        type: 'array',
        description: 'Convenience domain scope sets. Example: ["docs", "wiki"].',
        items: { type: 'string' },
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  validate(input) {
    if (!ACTIONS.has(input.action)) throw new Error(`action must be one of: ${[...ACTIONS].join(', ')}`);
  },
  async handler(input, ctx) {
    const baseConfig = await loadFeishuAuthConfig(ctx.config || {});
    const config = configWithOAuthScopes(baseConfig, scopesFromAuthInput(input));
    switch (input.action) {
      case 'login': {
        const { auth, tokenData } = await authorizeAndWait(config, {
          signal: ctx.signal,
          emit: ctx.emit,
          action: 'login',
        });
        return {
          action: 'login',
          resourceType: 'authorization',
          authorizationRequired: false,
          flow: 'device',
          verificationUrl: auth.verificationUrl,
          authorizationUrl: auth.authorizationUrl,
          deviceCode: auth.deviceCode,
          expiresIn: tokenData.expiresIn,
          hasRefreshToken: Boolean(tokenData.refreshToken),
          message: 'Feishu user authorization completed. The token was saved for Feishu tools.',
        };
      }
      case 'start':
        return startDeviceAuthorization(config);
      case 'complete':
        return completeDeviceAuthorization(input, { config, signal: ctx.signal });
      case 'status':
        return tokenStatus(config);
      case 'logout':
        await clearUserToken();
        return {
          action: 'logout',
          resourceType: 'authorization',
          authorizationRequired: true,
          hasUserAccessToken: false,
          message: 'Feishu user token cleared.',
        };
      default:
        throw new Error(`Unsupported action: ${input.action}`);
    }
  },
  parseResult(output) {
    const content = JSON.stringify({
      message: output.message,
      flow: output.flow,
      authorizationRequired: output.authorizationRequired,
      authorizationUrl: output.authorizationUrl,
      verificationUrl: output.verificationUrl,
      deviceCode: output.deviceCode,
      expiresIn: output.expiresIn,
      expiresAt: output.expiresAt,
      hasUserAccessToken: output.hasUserAccessToken,
      hasRefreshToken: output.hasRefreshToken,
      userAccessTokenExpiresAt: output.userAccessTokenExpiresAt,
      refreshTokenExpiresAt: output.refreshTokenExpiresAt,
    }, null, 2);
    return {
      renderType: 'file-snippet',
      data: {
        path: 'feishu:authorization',
        encoding: 'utf-8',
        size: Buffer.byteLength(content, 'utf-8'),
        startLine: 1,
        endLine: content.split(/\r?\n/).length,
        truncated: false,
        contentPreview: content.slice(0, 4000),
        content,
      },
    };
  },
};
