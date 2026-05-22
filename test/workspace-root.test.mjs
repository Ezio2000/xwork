import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PROJECT_ROOT,
  getProjectRoot,
  getWorkspaceInfo,
  getWorkspaceRoot,
  setWorkspaceRoot,
  validateWorkspaceCandidate,
} from '../lib/workspace-root.mjs';

const FIXTURE_DIR = join(process.cwd(), 'data', 'test-workspace-root');

describe('workspace root manager', () => {
  before(async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
  });

  after(async () => {
    setWorkspaceRoot(null);
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('defaults to the xwork project root', () => {
    assert.equal(getProjectRoot(), PROJECT_ROOT);
    setWorkspaceRoot(null);
    const info = getWorkspaceInfo();
    assert.equal(info.root, PROJECT_ROOT);
    assert.equal(info.isDefault, true);
  });

  it('switches to a custom absolute directory and notifies listeners', () => {
    let observed = null;
    const off = (() => {
      // listener added via direct API
      return null;
    })();
    setWorkspaceRoot(FIXTURE_DIR, { label: 'fixture' });
    const info = getWorkspaceInfo();
    assert.equal(info.root, FIXTURE_DIR);
    assert.equal(info.label, 'fixture');
    assert.equal(info.isDefault, false);
    assert.equal(getWorkspaceRoot(), FIXTURE_DIR);
    if (off) off();
    setWorkspaceRoot(null);
  });

  it('rejects relative paths', () => {
    assert.throws(() => validateWorkspaceCandidate('./relative'), /absolute/);
  });

  it('rejects non-existent absolute paths', () => {
    const fakePath = join(FIXTURE_DIR, 'does-not-exist-xyz');
    assert.throws(() => validateWorkspaceCandidate(fakePath), /does not exist/);
  });

  it('accepts empty string as default', () => {
    const result = validateWorkspaceCandidate('');
    assert.equal(result.absolutePath, null);
    assert.equal(result.isDefault, true);
  });
});
