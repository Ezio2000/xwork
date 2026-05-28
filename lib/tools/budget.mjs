function integerMaxUses(tool) {
  const n = Number(tool?.maxUses);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function createToolBudgetGuard(tools = []) {
  const limits = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = typeof tool?.name === 'string' ? tool.name : '';
    if (!name) continue;
    const maxUses = integerMaxUses(tool);
    if (maxUses !== null) limits.set(name, maxUses);
  }

  const counts = new Map();

  return {
    beforeToolCall(call) {
      const name = typeof call?.name === 'string' ? call.name : '';
      if (!limits.has(name)) return null;

      const maxUses = limits.get(name);
      const used = counts.get(name) || 0;
      if (used >= maxUses) {
        return {
          skip: true,
          output: `Tool budget reached for ${name}: maximum ${maxUses} uses per agent run. Stop calling this tool and answer from collected results.`,
        };
      }

      counts.set(name, used + 1);
      return null;
    },
  };
}
