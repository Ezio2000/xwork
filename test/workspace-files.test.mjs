import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchWorkspaceFiles } from '../lib/workspace-files.mjs';

describe('workspace files', () => {
  it('searches indexable workspace files', async () => {
    const result = await searchWorkspaceFiles({ query: 'package.json', limit: 5 });
    assert.ok(result.files.some(file => file.path === 'package.json'));
  });
});
