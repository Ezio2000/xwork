import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { runTool } from '../runner.mjs';
import { listTools } from '../registry.mjs';
import { tool } from './index.mjs';

const FIXTURE_DIR = join(process.cwd(), 'data', 'test-code-outline');

function ctx() {
  return { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false };
}

describe('code_outline tool', () => {
  before(async () => {
    await mkdir(FIXTURE_DIR, { recursive: true });
  });

  after(async () => {
    await rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const registered = tools.find(t => t.id === 'code_outline');
    assert.ok(registered);
    assert.equal(registered.dangerLevel, 'low');
    assert.equal(tool.defaultEnabled, true);
  });

  it('extracts JS functions, classes, and arrow assignments', async () => {
    const rel = 'data/test-code-outline/sample.mjs';
    const source = [
      'export function alpha(x, y) { return x + y; }',
      'export class Beta {',
      '  greet() { return "hi"; }',
      '}',
      'export const gamma = (n) => n * 2;',
      'const delta = async function fancy(a) { return a; };',
    ].join('\n');
    await writeFile(join(process.cwd(), rel), source, 'utf8');

    const result = await runTool(
      { id: 'toolu_co1', name: 'code_outline', input: { path: rel } },
      ctx(),
    );
    assert.equal(result.isError, false, String(result.output || ''));
    assert.equal(result.render.renderType, 'symbol-list');
    const names = result.render.data.symbols.map(s => s.name);
    assert.ok(names.includes('alpha'), `missing alpha; got: ${names.join(',')}`);
    assert.ok(names.includes('Beta'));
    assert.ok(names.includes('gamma'));
  });

  it('extracts Python def and class symbols', async () => {
    const rel = 'data/test-code-outline/sample.py';
    const source = [
      'def foo(a, b):',
      '    return a + b',
      '',
      'class Bar:',
      '    def __init__(self):',
      '        self.x = 1',
      '',
      'async def baz():',
      '    pass',
    ].join('\n');
    await writeFile(join(process.cwd(), rel), source, 'utf8');

    const result = await runTool(
      { id: 'toolu_co2', name: 'code_outline', input: { path: rel } },
      ctx(),
    );
    assert.equal(result.isError, false);
    const names = result.render.data.symbols.map(s => s.name);
    assert.ok(names.includes('foo'));
    assert.ok(names.includes('Bar'));
    assert.ok(names.includes('__init__'));
    assert.ok(names.includes('baz'));
  });

  it('rejects unsupported language extensions', async () => {
    const rel = 'data/test-code-outline/sample.txt';
    await writeFile(join(process.cwd(), rel), 'plain text\n', 'utf8');
    const result = await runTool(
      { id: 'toolu_co3', name: 'code_outline', input: { path: rel } },
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(String(result.output || ''), /Unsupported language/);
  });
});
