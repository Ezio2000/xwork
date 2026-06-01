import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createExpertAgent,
  deleteExpertAgent,
  DEFAULT_EXPERT_AGENT_ID,
  listExpertAgents,
  resetExpertAgent,
  updateExpertAgent,
} from '../lib/agents/profiles.mjs';
import { runSubagent } from '../lib/agents/subagent-runtime.mjs';
import { getEnabledToolDefinitions, listTools, updateToolConfig } from '../lib/tools/registry.mjs';

describe('expert agent profiles', () => {
  it('exposes the built-in default expert agent', async () => {
    const agents = await listExpertAgents();
    const general = agents.find(agent => agent.id === DEFAULT_EXPERT_AGENT_ID);

    assert.ok(general);
    assert.equal(general.builtin, true);
    assert.equal(general.isDefault, true);
    assert.equal(general.enabled, true);
    assert.equal(general.maxTurns, 30);
    assert.equal(general.timeoutMs, 120000);
    assert.equal(general.maxOutputChars, 2400);
    assert.ok(general.allowedTools.includes('web_search'));
  });

  it('exposes the built-in xwork scenario expert catalog', async () => {
    const agents = await listExpertAgents();
    const scenarioAgents = agents.filter(agent => agent.id.startsWith('xwork_'));
    const ids = new Set(scenarioAgents.map(agent => agent.id));

    assert.equal(scenarioAgents.length, 6);
    for (const requiredId of [
      'xwork_code_expert',
      'xwork_system_design_expert',
      'xwork_frontend_product_expert',
      'xwork_research_integration_expert',
      'xwork_operations_expert',
      'xwork_workspace_data_expert',
    ]) {
      assert.ok(ids.has(requiredId), `missing scenario expert: ${requiredId}`);
    }
    assert.ok(!ids.has('xwork_code_review_expert'));
    assert.ok(!ids.has('xwork_security_review_expert'));

    for (const agent of scenarioAgents) {
      assert.equal(agent.builtin, true);
      assert.equal(agent.enabled, true);
      assert.equal(agent.allowSubagents, false);
      assert.ok(agent.title);
      assert.ok(agent.description);
      assert.ok(agent.selectionPrompt);
      assert.ok(agent.systemPrompt);
      assert.ok(agent.outputContract);
      assert.ok(Array.isArray(agent.allowedTools));
      assert.ok(agent.allowedTools.length > 0);
    }

    const expectedBudgets = {
      xwork_code_expert: [180000, 4200],
      xwork_system_design_expert: [180000, 4000],
      xwork_frontend_product_expert: [180000, 3800],
      xwork_research_integration_expert: [300000, 7000],
      xwork_operations_expert: [240000, 5000],
      xwork_workspace_data_expert: [240000, 6500],
    };
    for (const [id, [timeoutMs, maxOutputChars]] of Object.entries(expectedBudgets)) {
      const agent = agents.find(item => item.id === id);
      assert.equal(agent?.timeoutMs, timeoutMs, `${id} timeoutMs`);
      assert.equal(agent?.maxOutputChars, maxOutputChars, `${id} maxOutputChars`);
    }
  });

  it('creates, updates, and deletes a custom expert agent', async () => {
    const id = `agent_test_${Date.now()}`;
    const created = await createExpertAgent({
      id,
      title: 'Test Reviewer',
      description: 'Checks test behavior',
      selectionPrompt: 'Use for test-only assertions.',
      systemPrompt: 'You review tests and report concise findings.',
      outputContract: 'Return one bullet.',
      allowedTools: ['calculator'],
      maxTurns: 2,
      timeoutMs: 5000,
      maxOutputChars: 600,
    });

    try {
      assert.equal(created.id, id);
      assert.equal(created.builtin, false);
      assert.deepEqual(created.allowedTools, ['calculator']);

      const updated = await updateExpertAgent(id, { enabled: false, maxTurns: 100 });
      assert.equal(updated.enabled, false);
      assert.equal(updated.maxTurns, 100);
    } finally {
      const deleted = await deleteExpertAgent(id);
      assert.equal(deleted.ok, true);
    }
  });

  it('limits expert tools to tools enabled for the main agent', async () => {
    const id = `agent_tool_policy_${Date.now()}`;
    const blockedId = `${id}_blocked`;
    const tools = await listTools();
    const calculator = tools.find(tool => tool.id === 'calculator');
    const webSearch = tools.find(tool => tool.id === 'web_search');

    await updateToolConfig('calculator', {
      enabled: true,
      timeoutMs: calculator?.timeoutMs ?? 10000,
    });
    await updateToolConfig('web_search', {
      enabled: true,
      timeoutMs: webSearch?.timeoutMs ?? 10000,
    });

    const created = await createExpertAgent({
      id,
      title: 'Tool Policy Expert',
      description: 'Checks tool filtering.',
      selectionPrompt: 'Use for tool policy tests.',
      systemPrompt: 'Report tool policy facts.',
      outputContract: 'Return one bullet.',
      allowedTools: ['calculator', 'web_search'],
      maxTurns: 1,
      timeoutMs: 5000,
      maxOutputChars: 600,
    });

    try {
      assert.deepEqual(created.allowedTools, ['calculator', 'web_search']);

      await updateToolConfig('calculator', { enabled: false });

      const agents = await listExpertAgents();
      const filtered = agents.find(agent => agent.id === id);
      assert.deepEqual(filtered.allowedTools, ['web_search']);

      const definitions = await getEnabledToolDefinitions();
      const delegateTask = definitions.find(tool => tool.name === 'delegate_task');
      const catalogProfile = delegateTask.expertAgents.find(agent => agent.id === id);
      assert.deepEqual(catalogProfile.allowedTools, ['web_search']);

      const updateRejected = await updateExpertAgent(id, { allowedTools: ['calculator'] });
      assert.equal(updateRejected.status, 400);
      assert.match(updateRejected.error, /calculator/);

      const createRejected = await createExpertAgent({
        id: blockedId,
        title: 'Blocked Tool Expert',
        systemPrompt: 'This should not save.',
        allowedTools: ['calculator'],
      });
      assert.equal(createRejected.status, 400);
      assert.match(createRejected.error, /calculator/);
    } finally {
      await deleteExpertAgent(id);
      await deleteExpertAgent(blockedId);
      await updateToolConfig('calculator', {
        enabled: calculator?.enabled ?? true,
        timeoutMs: calculator?.timeoutMs ?? 10000,
      });
      await updateToolConfig('web_search', {
        enabled: webSearch?.enabled ?? true,
        timeoutMs: webSearch?.timeoutMs ?? 10000,
      });
    }
  });

  it('injects enabled expert agents into delegate_task tool definitions', async () => {
    const tools = await getEnabledToolDefinitions();
    const delegateTask = tools.find(tool => tool.name === 'delegate_task');

    assert.ok(delegateTask);
    assert.ok(delegateTask.expertAgents.some(agent => agent.id === DEFAULT_EXPERT_AGENT_ID));
    assert.ok(delegateTask.expertAgents.some(agent => agent.id === 'xwork_code_expert'));
    assert.ok(delegateTask.expertAgents.length >= 7);
    assert.match(delegateTask.description, /Available expert agents/);
    assert.ok(delegateTask.inputSchema.properties.expertAgentId);
    assert.ok(delegateTask.inputSchema.properties.expertAgentId.enum.includes('xwork_system_design_expert'));
    assert.ok(!delegateTask.inputSchema.properties.expertAgentId.enum.includes('xwork_security_review_expert'));
  });

  it('runs with selected expert profile metadata and tool policy', async () => {
    const id = `agent_runtime_${Date.now()}`;
    const created = await createExpertAgent({
      id,
      title: 'Calculator Expert',
      description: 'Only uses calculator.',
      selectionPrompt: 'Use for arithmetic.',
      systemPrompt: 'You solve arithmetic.',
      outputContract: 'Return the numeric finding.',
      allowedTools: ['calculator'],
      maxTurns: 1,
      timeoutMs: 5000,
      maxOutputChars: 800,
    });

    try {
      let receivedConfig;
      const result = await runSubagent({
        task: 'Compute one thing',
        expertAgentId: created.id,
        config: { model: 'test-model', maxTurns: 5, tools: [{ name: 'calculator' }, { name: 'shell_command' }] },
        context: { conversationId: 'conv1', channelId: 'ch1', model: 'test-model', source: 'test', environment: 'test' },
        streamChat: async (config, _messages, onDelta, _onThink, onDone) => {
          receivedConfig = config;
          onDelta('42');
          onDone('42', 'end_turn', null);
          return {
            text: '42',
            content: [{ type: 'text', text: '42' }],
            stopReason: 'end_turn',
            usage: null,
            toolCalls: [],
            serverToolEvents: [],
          };
        },
        emitEvent: () => {},
      });

      assert.equal(result.expertAgent.id, created.id);
      assert.equal(result.limits.maxTurns, 1);
      assert.deepEqual(receivedConfig.tools.map(tool => tool.name), ['calculator']);
    } finally {
      await deleteExpertAgent(id);
    }
  });

  it('keeps the default expert agent protected from deletion', async () => {
    const deleteResult = await deleteExpertAgent(DEFAULT_EXPERT_AGENT_ID);
    assert.equal(deleteResult.status, 409);

    const resetCustom = await resetExpertAgent('not_builtin');
    assert.equal(resetCustom.status, 409);
  });

  it('allows built-in scenario experts to be reset but not deleted', async () => {
    const updated = await updateExpertAgent('xwork_code_expert', {
      enabled: false,
      title: 'Temporarily Customized Code Expert',
      maxTurns: 5,
    });
    assert.equal(updated.enabled, false);
    assert.equal(updated.title, 'Temporarily Customized Code Expert');

    const reset = await resetExpertAgent('xwork_code_expert');
    assert.equal(reset.id, 'xwork_code_expert');
    assert.equal(reset.title, 'Code Expert');
    assert.equal(reset.enabled, true);
    assert.equal(reset.maxTurns, 34);

    const deleteResult = await deleteExpertAgent('xwork_code_expert');
    assert.equal(deleteResult.status, 409);
  });

  it('maps retired built-in expert ids to compacted profiles at runtime', async () => {
    const result = await runSubagent({
      task: 'Review one thing',
      expertAgentId: 'xwork_code_review_expert',
      config: { model: 'test-model', maxTurns: 5, tools: [] },
      context: { conversationId: 'conv1', channelId: 'ch1', model: 'test-model', source: 'test', environment: 'test' },
      streamChat: async (_config, _messages, onDelta, _onThink, onDone) => {
        onDelta('ok');
        onDone('ok', 'end_turn', null);
        return {
          text: 'ok',
          content: [{ type: 'text', text: 'ok' }],
          stopReason: 'end_turn',
          usage: null,
          toolCalls: [],
          serverToolEvents: [],
        };
      },
      emitEvent: () => {},
    });

    assert.equal(result.expertAgent.id, 'xwork_code_expert');
    assert.equal(result.expertAgent.requestedId, 'xwork_code_review_expert');
  });
});
