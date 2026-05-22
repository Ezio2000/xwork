import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runTool } from '../lib/tools/runner.mjs';
import { listTools, updateToolConfig } from '../lib/tools/registry.mjs';
import { readFileTool } from '../lib/tools/builtin/read-file.mjs';

const FIXTURE_DIR = join(process.cwd(), 'data', 'test-read-file');

async function withReadFileEnabled(fn) {
  const tools = await listTools();
  const current = tools.find(tool => tool.id === 'read_file');
  if (!current?.enabled) {
    await updateToolConfig('read_file', { enabled: true, timeoutMs: readFileTool.timeoutMs });
  }
  try {
    return await fn();
  } finally {
    if (!current?.enabled) {
      await updateToolConfig('read_file', {
        enabled: false,
        timeoutMs: current?.timeoutMs ?? readFileTool.timeoutMs,
      });
    }
  }
}

describe('read_file tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const readFile = tools.find(tool => tool.id === 'read_file');

    assert.ok(readFile);
    assert.equal(readFile.dangerLevel, 'low');
    assert.equal(readFileTool.defaultEnabled, true);
    assert.equal(readFile.enabled, true);
  });

  it('reads a text file with line range metadata', async () => {
    await withReadFileEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_read_ok', name: 'read_file', input: { path: 'package.json', limit: 5 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.output.path, 'package.json');
      assert.equal(result.output.startLine, 1);
      assert.equal(result.output.endLine, 5);
      assert.match(result.output.content, /"name": "xwork"/);
      assert.equal(result.render.renderType, 'file-snippet');
      assert.equal(result.render.data.path, 'package.json');
    });
  });

  it('rejects blocked globs such as node_modules', async () => {
    await mkdir(join(FIXTURE_DIR, 'node_modules', 'pkg'), { recursive: true });
    const target = join(FIXTURE_DIR, 'node_modules', 'pkg', 'secret.txt');
    await writeFile(target, 'hidden\n', 'utf-8');

    try {
      await withReadFileEnabled(async () => {
        const result = await runTool(
          { id: 'toolu_read_blocked_glob', name: 'read_file', input: { path: 'data/test-read-file/node_modules/pkg/secret.txt' } },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, true);
        assert.match(String(result.output), /blocked/i);
      });
    } finally {
      await rm(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('rejects blocked extensions and binary content', async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
    const pngPath = join(FIXTURE_DIR, 'image.png');
    await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00]), 'binary');

    try {
      await withReadFileEnabled(async () => {
        const result = await runTool(
          { id: 'toolu_read_png', name: 'read_file', input: { path: 'data/test-read-file/image.png' } },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, true);
        assert.match(String(result.output), /binary|not supported/i);
      });
    } finally {
      await rm(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('rejects .env secret files', async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(join(FIXTURE_DIR, '.env'), 'API_KEY=secret\n', 'utf-8');

    try {
      await withReadFileEnabled(async () => {
        const result = await runTool(
          { id: 'toolu_read_env', name: 'read_file', input: { path: 'data/test-read-file/.env' } },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, true);
        assert.match(String(result.output), /\.env/i);
      });
    } finally {
      await rm(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('allows .env.example files', async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(join(FIXTURE_DIR, '.env.example'), 'API_KEY=\n', 'utf-8');

    try {
      await withReadFileEnabled(async () => {
        const result = await runTool(
          { id: 'toolu_read_env_example', name: 'read_file', input: { path: 'data/test-read-file/.env.example' } },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false);
        assert.match(result.output.content, /API_KEY=/);
      });
    } finally {
      await rm(FIXTURE_DIR, { recursive: true, force: true });
    }
  });

  it('accepts absolute paths that resolve to the workspace root with different casing', async () => {
    if (process.platform !== 'darwin') {
      return;
    }

    await withReadFileEnabled(async () => {
      const alternateCasePath = join(process.cwd().replace('/AI/', '/ai/'), 'package.json');
      const result = await runTool(
        { id: 'toolu_read_case_variant', name: 'read_file', input: { path: alternateCasePath, limit: 3 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false, String(result.output || ''));
      assert.equal(result.output.path, 'package.json');
      assert.match(result.output.content, /"name": "xwork"/);
    });
  });

  it('rejects paths outside the workspace', async () => {
    await withReadFileEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_read_outside', name: 'read_file', input: { path: '../package.json' } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, true);
      assert.match(String(result.output), /workspace root/i);
    });
  });
});
