export const toolNames = ['ask_user'];

export function onToolCall(evt, stream, effects, helpers) {
  for (const tool of evt.tools || []) {
    if (tool.name !== 'ask_user' || !tool.id) continue;
    const existing = stream.blocks.find(block => block.type === 'ask-user' && block.toolCallId === tool.id);
    if (!existing) {
      stream.blocks.push({
        type: 'ask-user',
        toolCallId: tool.id,
        status: 'waiting',
        kind: tool.input?.kind || 'text',
        question: tool.input?.question || 'Waiting for your answer…',
        context: tool.input?.context || '',
        options: tool.input?.options,
        fields: tool.input?.fields,
        allowSkip: tool.input?.allowSkip !== false,
        allowCustom: tool.input?.allowCustom === true,
        collapsed: false,
      });
    }
  }
}

export function onAskUserPending(evt, stream, effects) {
  const toolCallId = evt.id;
  if (!toolCallId) return;
  const block = {
    type: 'ask-user',
    toolCallId,
    status: 'waiting',
    kind: evt.kind || 'text',
    question: evt.question || '',
    context: evt.context || '',
    options: evt.options,
    fields: evt.fields,
    allowSkip: evt.allowSkip !== false,
    allowCustom: evt.allowCustom === true,
    recommended: evt.recommended,
    default: evt.default,
    multiline: evt.multiline !== false,
    placeholder: evt.placeholder || '',
    min: evt.min,
    max: evt.max,
    minSelections: evt.minSelections,
    maxSelections: evt.maxSelections,
    collapsed: false,
  };
  const existing = stream.blocks.find(item => item.type === 'ask-user' && item.toolCallId === toolCallId);
  if (existing) Object.assign(existing, block);
  else stream.blocks.push(block);
  effects.scheduleRender();
}

export function onToolResultTool(tool, stream, effects, helpers) {
  if (tool.renderType !== 'ask-user' || !tool.id) return false;
  const existing = helpers.findToolBlockByCallId?.(stream, tool.id);
  const block = existing || { type: 'ask-user', toolCallId: tool.id };
  Object.assign(block, {
    status: tool.isError ? 'error' : (tool.data?.status || 'answered'),
    ...tool.data,
  });
  if (!existing) stream.blocks.push(block);
  helpers.collapseFinishedToolBlock?.(block);
  return true;
}
