import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  grepWorkspaceFiles,
  listWorkspaceFilesByGlob,
  searchWorkspaceFiles,
} from '../lib/workspace-files.mjs';

describe('workspace files', () => {
  it('searches indexable workspace files', async () => {
    const result = await searchWorkspaceFiles({ query: 'package.json', limit: 5 });
    assert.ok(result.files.some(file => file.path === 'package.json'));
  });

  it('lists files by glob pattern', async () => {
    const result = await listWorkspaceFilesByGlob({ pattern: 'lib/workspace-files.mjs', limit: 5 });
    assert.ok(result.files.some(file => file.path === 'lib/workspace-files.mjs'));
  });

  it('greps with path and glob filters', async () => {
    const result = await grepWorkspaceFiles({
      pattern: 'searchWorkspaceFiles',
      glob: 'lib/workspace-files.mjs',
      headLimit: 5,
    });
    assert.ok(result.matches.some(match => match.path === 'lib/workspace-files.mjs'));
  });
});
