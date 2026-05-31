import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runTool } from '../runner.mjs';
import { listTools, updateToolConfig } from '../registry.mjs';
import { tool as grepTool } from './index.mjs';
import { tool as globTool } from '../glob/index.mjs';
import {
  buildSearchRegex,
  grepWorkspaceFiles,
  listWorkspaceFilesByGlob,
  invalidateWorkspaceFileIndex,
} from '../../workspace-files.mjs';

const FIXTURE_DIR = join(process.cwd(), 'data', 'test-grep-glob');

async function withToolEnabled(toolId, toolDef, fn) {
  const tools = await listTools();
  const current = tools.find(tool => tool.id === toolId);
  if (!current?.enabled) {
    await updateToolConfig(toolId, { enabled: true, timeoutMs: toolDef.timeoutMs });
  }
  try {
    return await fn();
  } finally {
    if (!current?.enabled) {
      await updateToolConfig(toolId, {
        enabled: false,
        timeoutMs: current?.timeoutMs ?? toolDef.timeoutMs,
      });
    }
  }
}

describe('workspace grep/glob helpers', () => {
  it('buildSearchRegex treats invalid regex as a literal', () => {
    const regex = buildSearchRegex('foo[bar', { caseInsensitive: false });
    assert.match('prefix foo[bar suffix', regex);
    assert.doesNotMatch('foobar', regex);
  });

  it('lists files by glob pattern', async () => {
    const result = await listWorkspaceFilesByGlob({ pattern: 'package.json', limit: 5 });
    assert.ok(result.files.some(file => file.path === 'package.json'));
  });

  it('greps indexed workspace files', async () => {
    const result = await grepWorkspaceFiles({ pattern: '"name": "xwork"', glob: 'package.json', headLimit: 5 });
    assert.ok(result.matches.some(match => match.path === 'package.json'));
  });
});

describe('grep tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const grep = tools.find(tool => tool.id === 'grep');
    assert.ok(grep);
    assert.equal(grepTool.defaultEnabled, true);
    assert.equal(grep.enabled, true);
  });

  it('returns grep-matches render data', async () => {
    await withToolEnabled('grep', grepTool, async () => {
      const result = await runTool(
        { id: 'toolu_grep_ok', name: 'grep', input: { pattern: 'xwork', glob: 'package.json', head_limit: 3 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.render.renderType, 'grep-matches');
      assert.ok(result.output.matches.length > 0);
    });
  });
});

describe('glob tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const glob = tools.find(tool => tool.id === 'glob');
    assert.ok(glob);
    assert.equal(globTool.defaultEnabled, true);
    assert.equal(glob.enabled, true);
  });

  it('returns glob-list render data', async () => {
    await withToolEnabled('glob', globTool, async () => {
      const result = await runTool(
        { id: 'toolu_glob_ok', name: 'glob', input: { pattern: 'lib/tools/*/index.mjs', limit: 30 } },
        { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
      );

      assert.equal(result.isError, false);
      assert.equal(result.render.renderType, 'glob-list');
      assert.ok(result.output.files.some(file => file.path.endsWith('grep/index.mjs')));
    });
  });

  it('respects blocked globs in fixture files', async () => {
    await mkdir(join(FIXTURE_DIR, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(FIXTURE_DIR, 'node_modules', 'pkg', 'needle.txt'), 'needle-token\n', 'utf-8');
    invalidateWorkspaceFileIndex();

    try {
      await withToolEnabled('grep', grepTool, async () => {
        const result = await runTool(
          {
            id: 'toolu_grep_blocked',
            name: 'grep',
            input: { pattern: 'needle-token', path: 'data/test-grep-glob' },
          },
          { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false },
        );

        assert.equal(result.isError, false);
        assert.equal(result.output.matches.length, 0);
      });
    } finally {
      await rm(FIXTURE_DIR, { recursive: true, force: true });
      invalidateWorkspaceFileIndex();
    }
  });
});
