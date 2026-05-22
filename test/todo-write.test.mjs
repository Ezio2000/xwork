import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runTool } from '../lib/tools/runner.mjs';
import { listTools } from '../lib/tools/registry.mjs';
import { todoWriteTool } from '../lib/tools/builtin/todo-write.mjs';

function ctx() {
  return { conversationId: 'test', source: 'test', environment: 'test', persistToolRun: false };
}

describe('todo_write tool', () => {
  it('is registered and enabled by default', async () => {
    const tools = await listTools();
    const tool = tools.find(t => t.id === 'todo_write');
    assert.ok(tool);
    assert.equal(tool.dangerLevel, 'low');
    assert.equal(todoWriteTool.defaultEnabled, true);
    assert.equal(tool.enabled, true);
  });

  it('returns a todo-list render block with status counts', async () => {
    const result = await runTool(
      {
        id: 'toolu_t1',
        name: 'todo_write',
        input: {
          todos: [
            { id: '1', content: 'design', status: 'completed' },
            { id: '2', content: 'implement', status: 'in_progress' },
            { id: '3', content: 'test', status: 'pending' },
          ],
        },
      },
      ctx(),
    );
    assert.equal(result.isError, false);
    assert.equal(result.render.renderType, 'todo-list');
    assert.equal(result.render.data.total, 3);
    assert.equal(result.render.data.counts.completed, 1);
    assert.equal(result.render.data.counts.in_progress, 1);
    assert.equal(result.render.data.counts.pending, 1);
  });

  it('rejects duplicate ids', async () => {
    const result = await runTool(
      {
        id: 'toolu_t2',
        name: 'todo_write',
        input: {
          todos: [
            { id: 'a', content: 'one', status: 'pending' },
            { id: 'a', content: 'two', status: 'pending' },
          ],
        },
      },
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(String(result.output || ''), /Duplicate/i);
  });

  it('rejects invalid status values', async () => {
    const result = await runTool(
      {
        id: 'toolu_t3',
        name: 'todo_write',
        input: { todos: [{ id: '1', content: 'x', status: 'doing' }] },
      },
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(String(result.output || ''), /status must be one of/);
  });

  it('rejects empty list', async () => {
    const result = await runTool(
      { id: 'toolu_t4', name: 'todo_write', input: { todos: [] } },
      ctx(),
    );
    assert.equal(result.isError, true);
    assert.match(String(result.output || ''), /must not be empty/);
  });
});
