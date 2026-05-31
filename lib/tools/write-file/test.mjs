import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runTool } from '../runner.mjs';
import { listTools, updateToolConfig } from '../registry.mjs';
import { tool as writeFileTool } from './index.mjs';

const FIXTURE_DIR = join(process.cwd(), 'data', 'test-write-file');

async function withWriteFileEnabled(fn) {
  const tools = await listTools();
  const current = tools.find(tool => tool.id === 'write_file');
  if (!current?.enabled) {
    await updateToolConfig('write_file', { enabled: true, timeoutMs: writeFileTool.timeoutMs });
  }
  try {
    return await fn();
  } finally {
    if (!current?.enabled) {
      await updateToolConfig('write_file', {
        enabled: false,
        timeoutMs: current?.timeoutMs ?? writeFileTool.timeoutMs,
      });
    }
  }
}

function runContext() {
  return { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false };
}

describe('write_file tool', () => {
  before(async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const writeFile = tools.find(t => t.id === 'write_file');
    assert.ok(writeFile);
    assert.equal(writeFile.dangerLevel, 'high');
    assert.equal(writeFileTool.defaultEnabled, true);
  });

  it('creates a new file in overwrite mode and returns file-write render data', async () => {
    await withWriteFileEnabled(async () => {
      const targetRel = 'data/test-write-file/new.txt';
      const result = await runTool(
        { id: 'toolu_w1', name: 'write_file', input: { path: targetRel, content: 'hello\nworld\n' } },
        runContext(),
      );
      assert.equal(result.isError, false, String(result.output || ''));
      assert.equal(result.output.created, true);
      assert.equal(result.output.afterLines, 3);
      assert.equal(result.render.renderType, 'file-write');
      const persisted = await readFile(join(process.cwd(), targetRel), 'utf8');
      assert.equal(persisted, 'hello\nworld\n');
    });
  });

  it('appends to an existing file with newline separation', async () => {
    await withWriteFileEnabled(async () => {
      const targetRel = 'data/test-write-file/log.txt';
      await writeFile(join(process.cwd(), targetRel), 'first', 'utf8');
      const result = await runTool(
        {
          id: 'toolu_w2',
          name: 'write_file',
          input: { path: targetRel, mode: 'append', content: 'second' },
        },
        runContext(),
      );
      assert.equal(result.isError, false);
      assert.equal(result.output.mode, 'append');
      const persisted = await readFile(join(process.cwd(), targetRel), 'utf8');
      assert.equal(persisted, 'first\nsecond');
    });
  });

  it('applies a unique str_replace edit', async () => {
    await withWriteFileEnabled(async () => {
      const targetRel = 'data/test-write-file/replace.txt';
      await writeFile(join(process.cwd(), targetRel), 'alpha\nbeta\ngamma\n', 'utf8');
      const result = await runTool(
        {
          id: 'toolu_w3',
          name: 'write_file',
          input: {
            path: targetRel,
            mode: 'str_replace',
            old_string: 'beta',
            new_string: 'BETA',
          },
        },
        runContext(),
      );
      assert.equal(result.isError, false);
      assert.equal(result.output.replacements, 1);
      const persisted = await readFile(join(process.cwd(), targetRel), 'utf8');
      assert.equal(persisted, 'alpha\nBETA\ngamma\n');
    });
  });

  it('rejects str_replace when old_string is ambiguous', async () => {
    await withWriteFileEnabled(async () => {
      const targetRel = 'data/test-write-file/ambiguous.txt';
      await writeFile(join(process.cwd(), targetRel), 'x\nx\n', 'utf8');
      const result = await runTool(
        {
          id: 'toolu_w4',
          name: 'write_file',
          input: { path: targetRel, mode: 'str_replace', old_string: 'x', new_string: 'y' },
        },
        runContext(),
      );
      assert.equal(result.isError, true);
      assert.match(String(result.output || ''), /more than once/);
    });
  });

  it('rejects paths outside the workspace root', async () => {
    await withWriteFileEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_w5', name: 'write_file', input: { path: '../escape.txt', content: 'no' } },
        runContext(),
      );
      assert.equal(result.isError, true);
      assert.match(String(result.output || ''), /workspace/);
    });
  });

  it('refuses .env files', async () => {
    await withWriteFileEnabled(async () => {
      const result = await runTool(
        { id: 'toolu_w6', name: 'write_file', input: { path: 'data/test-write-file/.env', content: 'SECRET=1' } },
        runContext(),
      );
      assert.equal(result.isError, true);
      assert.match(String(result.output || ''), /environment secret/i);
    });
  });
});
