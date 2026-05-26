export const AUTO_COLLAPSE_TOOL_BLOCK_TYPES = new Set([
  'source-cards',
  'sources',
  'web-fetch',
  'file-snippet',
  'file-write',
  'symbol-list',
  'grep-matches',
  'glob-list',
  'dir-list',
  'git-output',
  'shell-command',
  'uuid-list',
  'browser-action',
  'subagent-run',
  'ask-user',
  'tool-running',
  'about-xwork',
]);

const SPECIAL_TOOL_CALL_NAMES = new Set([
  'browser_action',
  'ask_user',
  'shell_command',
  'delegate_task',
]);

function summarizeInputValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const text = JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  } catch {
    return '';
  }
}

function toolRunningLabel(tool) {
  const name = tool?.name || 'tool';
  const input = tool?.input || {};
  switch (name) {
    case 'grep':
      return `grep ${input.pattern || ''}`.trim();
    case 'glob':
      return `glob ${input.pattern || ''}`.trim();
    case 'list_dir':
      return `list ${input.path || '.'}`.trim();
    case 'read_file':
      return `read ${input.path || ''}`.trim();
    case 'write_file':
      return `write ${input.path || ''}`.trim();
    case 'code_outline':
      return `outline ${input.path || ''}`.trim();
    case 'git':
      return `git ${input.action || ''}`.trim();
    case 'web_search':
      return `search ${input.query || ''}`.trim();
    case 'web_fetch':
      return `fetch ${input.url || ''}`.trim();
    case 'get_current_time':
      return `time ${input.timezone || 'local'}`.trim();
    case 'calculator':
      return `calc ${summarizeInputValue(input.expression)}`.trim();
    case 'uuid_gen':
      return `uuid x${input.count || 1}`;
    default:
      return name.replace(/_/g, ' ');
  }
}

export function isTerminalSubagentBlock(block) {
  const status = String(block?.status || '').toLowerCase();
  return block?.type === 'subagent-run' && status && status !== 'running' && status !== 'tool_error';
}

export function isToolBlock(block) {
  return AUTO_COLLAPSE_TOOL_BLOCK_TYPES.has(block?.type);
}

export function shouldKeepToolBlockExpanded(block) {
  if (!block) return false;
  if (block.type === 'ask-user' && block.status === 'waiting') return true;
  if (block.status === 'running') return true;
  if (block.type === 'subagent-run') {
    const status = String(block.status || '').toLowerCase();
    return status === 'running' || status === 'tool_error';
  }
  return false;
}

export function collapseFinishedToolBlock(block) {
  if (!block || shouldKeepToolBlockExpanded(block)) return;
  if (isToolBlock(block)) block.collapsed = true;
}

export function collapseFinishedToolBlocks(blocks) {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) collapseFinishedToolBlock(block);
}

export function buildRunningToolBlock(tool) {
  return {
    type: 'tool-running',
    toolCallId: tool.id,
    toolName: tool.name,
    status: 'running',
    label: toolRunningLabel(tool),
    input: tool.input || {},
    collapsed: false,
  };
}

export function shouldCreateRunningToolBlock(tool) {
  if (!tool?.id || !tool?.name) return false;
  return !SPECIAL_TOOL_CALL_NAMES.has(tool.name);
}

export function collapseToolToggleElements(rootEl) {
  if (!rootEl) return;
  rootEl.querySelectorAll([
    '.sources-toggle',
    '.shell-command-toggle',
    '.browser-action-toggle',
    '.web-fetch-toggle',
    '.subagent-toggle',
    '.uuid-toggle',
    '.about-xwork-toggle',
  ].join(',')).forEach(toggle => toggle.classList.add('collapsed'));
}
