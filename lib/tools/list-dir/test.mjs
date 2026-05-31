import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTool } from '../runner.mjs';
import { listTools } from '../registry.mjs';
import { tool as listDirTool } from './index.mjs';
import { tool as gitTool } from '../git/index.mjs';
import { listWorkspaceDirectory } from '../../workspace-files.mjs';
import { runGitAction } from '../../git-workspace.mjs';

function ctx() {
  return { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false };
}

describe('list_dir helper', () => {
  it('lists immediate children under lib/tools', async () => {
    const result = await listWorkspaceDirectory({ path: 'lib/tools', depth: 1, limit: 50 });
    assert.equal(result.path, 'lib/tools');
    assert.ok(result.entries.some(entry => entry.name === 'read-file' && entry.kind === 'directory'));
    assert.ok(result.entries.some(entry => entry.name === 'registry.mjs' && entry.kind === 'file'));
  });

  it('marks skipped directories such as node_modules', async () => {
    const result = await listWorkspaceDirectory({ path: '.', depth: 1, limit: 200 });
    const nodeModules = result.entries.find(entry => entry.name === 'node_modules');
    assert.ok(nodeModules);
    assert.equal(nodeModules.skipped, true);
  });
});

describe('list_dir tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const listDir = tools.find(item => item.id === 'list_dir');
    assert.ok(listDir);
    assert.equal(listDirTool.defaultEnabled, true);
    assert.equal(listDir.enabled, true);
  });

  it('returns dir-list render data', async () => {
    const result = await runTool(
      {
        id: 'toolu_list_dir_ok',
        name: 'list_dir',
        input: { path: 'lib/tools/read-file', depth: 1, limit: 20 },
      },
      ctx(),
    );

    assert.equal(result.isError, false);
    assert.equal(result.render.renderType, 'dir-list');
    assert.ok(result.output.entries.some(entry => entry.name.endsWith('.mjs')));
  });
});

describe('git helper', () => {
  it('returns repository status for the workspace', async () => {
    const result = await runGitAction({ action: 'status' });
    assert.equal(result.action, 'status');
    assert.equal(typeof result.output, 'string');
    assert.ok(result.summary);
  });

  it('lists recent commits', async () => {
    const result = await runGitAction({ action: 'log', maxCount: 3 });
    assert.equal(result.action, 'log');
    assert.ok(result.output.split('\n').filter(Boolean).length <= 3);
  });

  it('rejects invalid refs', async () => {
    await assert.rejects(
      () => runGitAction({ action: 'show', ref: 'bad ref name' }),
      /invalid characters/i,
    );
  });
});

describe('git tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const git = tools.find(item => item.id === 'git');
    assert.ok(git);
    assert.equal(gitTool.defaultEnabled, true);
    assert.equal(git.enabled, true);
  });

  it('returns git-output render data for branch listing', async () => {
    const result = await runTool(
      {
        id: 'toolu_git_branch',
        name: 'git',
        input: { action: 'branch' },
      },
      ctx(),
    );

    assert.equal(result.isError, false);
    assert.equal(result.render.renderType, 'git-output');
    assert.equal(result.render.data.action, 'branch');
    assert.ok(String(result.output.output || '').includes('*') || result.output.summary?.current);
  });

  it('supports diff stat output', async () => {
    const result = await runTool(
      {
        id: 'toolu_git_diff',
        name: 'git',
        input: { action: 'diff', statOnly: true },
      },
      ctx(),
    );

    assert.equal(result.isError, false);
    assert.equal(result.render.data.action, 'diff');
  });
});
