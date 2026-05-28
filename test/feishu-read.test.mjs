import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';

import { formatToolOutput, runTool } from '../lib/tools/runner.mjs';
import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { feishuReadTool } from '../lib/tools/builtin/feishu-read.mjs';

const WRITES_REAL_TOOL_DB_SKIP = {
  skip: 'Skipped for now: this test writes persistent tool config in data/xwork.sqlite. Re-enable after test DB isolation is added.',
};

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
  it('is registered and enabled by default', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const tools = await listTools();
    const tool = tools.find(item => item.id === 'feishu_read');

    assert.ok(tool);
    assert.equal(tool.dangerLevel, 'low');
    assert.equal(feishuReadTool.defaultEnabled, true);
    assert.equal(tool.defaultConfig.app_id, undefined);
    assert.equal(tool.defaultConfig.defaultSheetRange, 'A1:Z100');
    assert.equal(tool.defaultConfig.defaultSheetMode, 'all_preview');
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

  it('reads docx raw content with user access token', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ code: 0, data: { content: '# Title\n\nBody' } });
    };

    try {
      await withFeishuReadEnabled({ user_access_token: 'u-docx-token' }, async () => {
        const result = await runTool(
          { id: 'toolu_feishu_doc', name: 'feishu_read', input: { action: 'read_doc', documentId: 'docx_token' } },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.documentId, 'docx_token');
        assert.match(result.output.content, /Title/);
        assert.equal(result.render.renderType, 'file-snippet');
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/docx\/v1\/documents\/docx_token\/raw_content/);
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-docx-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reads docx blocks with media assets and tree structure', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      return jsonResponse({
        code: 0,
        data: {
          has_more: false,
          items: [
            {
              block_id: 'heading_1',
              block_type: 3,
              children: ['image_1'],
              heading1: { elements: [{ text_run: { content: 'Overview' } }] },
            },
            {
              block_id: 'image_1',
              parent_id: 'heading_1',
              block_type: 27,
              image: { token: 'img_token_1', width: 640, height: 320 },
            },
          ],
        },
      });
    };

    try {
      await withFeishuReadEnabled({ user_access_token: 'u-docx-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_blocks',
            name: 'feishu_read',
            input: { action: 'get_doc_blocks', documentId: 'docx_token', pageSize: 50 },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.documentId, 'docx_token');
        assert.equal(result.output.blockCount, 2);
        assert.equal(result.output.assets[0].token, 'img_token_1');
        assert.equal(result.output.tree[0].children[0].block_id, 'image_1');
        assert.match(calls[0].url.pathname, /\/docx\/v1\/documents\/docx_token\/blocks$/);
        assert.equal(calls[0].url.searchParams.get('page_size'), '50');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-docx-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reads docx rich content as markdown with media references', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({
      code: 0,
      data: {
        has_more: false,
        items: [
          {
            block_id: 'heading_1',
            block_type: 3,
            heading1: { elements: [{ text_run: { content: 'Overview' } }] },
          },
          {
            block_id: 'paragraph_1',
            block_type: 2,
            text: { elements: [{ text_run: { content: 'Body text' } }] },
          },
          {
            block_id: 'image_1',
            block_type: 27,
            image: { token: 'img_token_1', name: 'diagram.png' },
          },
        ],
      },
    });

    try {
      await withFeishuReadEnabled({ user_access_token: 'u-docx-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_rich',
            name: 'feishu_read',
            input: { action: 'read_doc_rich', documentId: 'docx_token' },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.action, 'read_doc_rich');
        assert.match(result.output.content, /^# Overview/);
        assert.match(result.output.content, /Body text/);
        assert.match(result.output.content, /!\[diagram\.png\]\(feishu-media:img_token_1\)/);
        assert.equal(result.output.assets[0].token, 'img_token_1');
        assert.equal(result.render.data.contentFormat, 'markdown');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('downloads Feishu media to a local preview file', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers({
          'content-type': 'image/png',
          'content-disposition': 'attachment; filename="image.png"',
        }),
        arrayBuffer: async () => Buffer.from('png-bytes').buffer.slice(
          Buffer.from('png-bytes').byteOffset,
          Buffer.from('png-bytes').byteOffset + Buffer.from('png-bytes').byteLength,
        ),
      };
    };

    try {
      await withFeishuReadEnabled({ user_access_token: 'u-media-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_media',
            name: 'feishu_read',
            input: { action: 'download_media', fileToken: 'img_token_1' },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.fileToken, 'img_token_1');
        assert.equal(result.output.contentType, 'image/png');
        assert.equal(result.output.encoding, 'binary-file');
        assert.equal(result.output.contentBase64, undefined);
        assert.match(result.output.filename, /^img_token_1-[a-f0-9]{12}\.png$/);
        assert.equal(result.output.previewUrl, `/api/v1/tool-assets/feishu-media/${result.output.filename}`);
        assert.equal(await readFile(result.output.filePath, 'utf8'), 'png-bytes');
        assert.equal(result.render.renderType, 'feishu-media');
        assert.equal(result.render.data.previewUrl, result.output.previewUrl);
        const modelVisible = formatToolOutput(result.output);
        assert.doesNotMatch(modelVisible, /png-bytes|contentBase64|filePath/);
        assert.match(modelVisible, /displayedInUi/);
        assert.match(modelVisible, /Do not call browser_action/);
        assert.match(calls[0].url.pathname, /\/drive\/v1\/medias\/img_token_1\/download$/);
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-media-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
      await rm('data/feishu-media', { recursive: true, force: true });
    }
  });

  it('resolves a wiki URL to its docx object and reads raw content', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
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
      await withFeishuReadEnabled({ user_access_token: 'u-wiki-token' }, async () => {
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
        assert.equal(calls[0].url.searchParams.get('token'), 'wiki_node_token');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-wiki-token');
        assert.match(calls[1].url.pathname, /docx_obj_token\/raw_content$/);
        assert.equal(calls[1].options.headers.Authorization, 'Bearer u-wiki-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('routes wiki URLs to read_wiki even when the model chooses read_doc', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
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
      await withFeishuReadEnabled({ user_access_token: 'u-wiki-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_wiki_misrouted',
            name: 'feishu_read',
            input: {
              action: 'read_doc',
              url: 'https://example.feishu.cn/wiki/wiki_node_token',
            },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.action, 'read_wiki');
        assert.equal(result.output.wikiToken, 'wiki_node_token');
        assert.match(result.output.content, /Wiki Doc/);
        assert.equal(calls.some(call => call.url.pathname.includes('/docx/v1/documents/wiki_node_token/raw_content')), false);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('starts Device Flow when user_access_token is missing and reads wiki', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    const events = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
      if (path.includes('/oauth/v1/device_authorization')) {
        const body = JSON.parse(options.body);
        assert.equal(body.client_id, 'cli_xxx');
        assert.equal(body.client_secret, 'secret');
        return jsonResponse({
          device_code: 'device-code-1',
          expires_in: 600,
          interval: 2,
          verification_url: 'https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=abc&user_code=ABCD-EFGH',
        });
      }
      if (path.includes('/open-apis/authen/v2/oauth/token')) {
        return jsonResponse({
          access_token: 'u-device-token',
          expires_in: 7200,
        });
      }
      if (path.includes('/wiki/v2/spaces/get_node')) {
        assert.equal(options.headers.Authorization, 'Bearer u-device-token');
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
        assert.equal(options.headers.Authorization, 'Bearer u-device-token');
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

  it('reads wiki with the token saved by feishu_auth over stale feishu_read config', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
      assert.equal(options.headers.Authorization, 'Bearer u-auth-token');
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
      await withFeishuReadEnabled({
        app_id: 'cli_stale',
        app_secret: 'stale-secret',
        user_access_token: '',
      }, async () => {
        await withFeishuAuthConfig({
          app_id: 'cli_current',
          app_secret: 'current-secret',
          user_access_token: 'u-auth-token',
        }, async () => {
          const result = await runTool(
            {
              id: 'toolu_feishu_wiki_saved_auth',
              name: 'feishu_read',
              input: {
                action: 'read_wiki',
                url: 'https://example.feishu.cn/wiki/wiki_node_token',
              },
            },
            { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
          );

          assert.equal(result.isError, false, String(result.output || ''));
          assert.equal(result.output.objToken, 'docx_obj_token');
          assert.match(result.output.content, /Wiki Doc/);
          assert.equal(calls.length, 2);
        });
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reads spreadsheet ranges with a user access token', WRITES_REAL_TOOL_DB_SKIP, async () => {
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
      await withFeishuReadEnabled({ user_access_token: 'u-sheet-token' }, async () => {
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
        assert.match(result.output.content, /\| Name \| Score \|/);
        assert.match(result.output.content, /\| Alice \| 42 \|/);
        assert.equal(calls.length, 1);
        assert.match(calls[0].url.pathname, /values_batch_get$/);
        assert.equal(calls[0].url.searchParams.get('ranges'), 'sheet1!A1:B2');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-sheet-token');
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reads all sheet previews by default when no range is provided', WRITES_REAL_TOOL_DB_SKIP, async () => {
    const previousFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: new URL(String(url)), options });
      const path = calls[calls.length - 1].url.pathname;
      if (path.includes('/metainfo')) {
        return jsonResponse({
          code: 0,
          data: {
            properties: { title: 'Pricing' },
            sheets: [
              { sheetId: 'sheet1', title: '按token计费' },
              { sheetId: 'sheet2', title: '套餐价格' },
            ],
          },
        });
      }
      if (path.includes('/values_batch_get')) {
        return jsonResponse({
          code: 0,
          data: {
            revision: 4,
            valueRanges: [
              {
                range: 'sheet1!A1:Z100',
                majorDimension: 'ROWS',
                values: [
                  ['模型', 'input ($/MTok)', '支持API'],
                  ['deepseek-v4-flash', 0.14, true],
                ],
              },
              {
                range: 'sheet2!A1:Z100',
                majorDimension: 'ROWS',
                values: [
                  ['套餐名', '价格'],
                  ['Lite 周订阅', 5],
                ],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected path ${path}`);
    };

    try {
      await withFeishuReadEnabled({ user_access_token: 'u-sheet-token' }, async () => {
        const result = await runTool(
          {
            id: 'toolu_feishu_sheet_preview',
            name: 'feishu_read',
            input: {
              action: 'read_sheet',
              spreadsheetToken: 'spreadsheet_token',
            },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false, String(result.output || ''));
        assert.equal(result.output.sheetMode, 'all_preview');
        assert.equal(result.output.sheetCount, 2);
        assert.equal(result.output.omittedSheets, 0);
        assert.deepEqual(result.output.ranges, ['sheet1!A1:Z100', 'sheet2!A1:Z100']);
        assert.match(result.output.content, /## 按token计费 \(sheet1!A1:Z100\)/);
        assert.match(result.output.content, /\| 模型 \| input \(\$\/MTok\) \| 支持API \|/);
        assert.match(result.output.content, /## 套餐价格 \(sheet2!A1:Z100\)/);
        assert.match(result.output.content, /\| Lite 周订阅 \| 5 \|/);
        assert.equal(calls.length, 2);
        assert.match(calls[0].url.pathname, /metainfo$/);
        assert.match(calls[1].url.pathname, /values_batch_get$/);
        assert.deepEqual(calls[1].url.searchParams.getAll('ranges'), ['sheet1!A1:Z100', 'sheet2!A1:Z100']);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('gets Feishu user info with user id type options', WRITES_REAL_TOOL_DB_SKIP, async () => {
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
      await withFeishuReadEnabled({ user_access_token: 'u-user-token' }, async () => {
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
        assert.equal(calls[0].options.headers.Authorization, 'Bearer u-user-token');
        assert.equal(result.render.renderType, 'file-snippet');
        assert.match(result.render.data.content, /Alice/);
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('gets current authorized Feishu user without requiring a user id', WRITES_REAL_TOOL_DB_SKIP, async () => {
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

  it('uses the token saved by feishu_auth over a stale feishu_read token', WRITES_REAL_TOOL_DB_SKIP, async () => {
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

  it('starts device authorization explicitly', WRITES_REAL_TOOL_DB_SKIP, async () => {
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

  it('auto-opens device authorization, waits, saves token, and returns current user', WRITES_REAL_TOOL_DB_SKIP, async () => {
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

  it('starts device authorization when configured user token is invalid', WRITES_REAL_TOOL_DB_SKIP, async () => {
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

  it('completes device authorization and saves the user access token', WRITES_REAL_TOOL_DB_SKIP, async () => {
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
