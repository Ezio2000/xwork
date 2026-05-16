export const delegateTaskTool = {
  id: 'delegate_task',
  name: 'delegate_task',
  title: 'Delegate Task',
  description: 'Start a focused subagent for a bounded task. Use this when independent investigation, verification, or parallelizable work would help the parent answer.',
  category: 'agent',
  adapter: 'builtin',
  version: '1.0.0',
  dangerLevel: 'medium',
  defaultEnabled: true,
  timeoutMs: 125000,
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The concrete task for the subagent to complete.',
      },
      label: {
        type: 'string',
        description: 'Short display label for the subagent run.',
      },
      instructions: {
        type: 'string',
        description: 'Optional extra constraints or output format for the subagent.',
      },
      parentSummary: {
        type: 'string',
        description: 'Optional relevant context from the parent conversation.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },

  validate({ task, label, instructions, parentSummary }) {
    if (!task || typeof task !== 'string' || !task.trim()) {
      throw new Error('task is required');
    }
    if (task.length > 4000) throw new Error('task is too long');
    if (label !== undefined && typeof label !== 'string') throw new Error('label must be a string');
    if (instructions !== undefined && typeof instructions !== 'string') throw new Error('instructions must be a string');
    if (parentSummary !== undefined && typeof parentSummary !== 'string') throw new Error('parentSummary must be a string');
  },

  async handler(input, { context, signal }) {
    if (typeof context.runSubagent !== 'function') {
      throw new Error('Subagent runtime is not available');
    }

    return context.runSubagent({
      task: input.task.trim(),
      label: input.label || '',
      instructions: input.instructions || '',
      parentSummary: input.parentSummary || '',
      parentRunId: context.agentRunId || null,
      parentToolCallId: context.toolCallId || null,
      depth: context.agentDepth || 0,
      config: context.subagentConfig,
      context,
      signal,
      emitEvent: context.emitAgentEvent,
    });
  },

  parseResult(output) {
    return {
      renderType: 'subagent-run',
      data: {
        runId: output.runId,
        status: output.status,
        label: output.label,
        text: output.text,
        reason: output.reason,
        error: output.error,
      },
    };
  },
};
