import { api } from '../api-client.js';
import { sendMessage } from '../chat-stream.js';
import { dom } from '../dom.js';

const DEBOUNCE_MS = 120;
const MAX_RESULTS = 20;

let mentionState = null;
let debounceTimer = null;
let searchRequestId = 0;

function closeMentionMenu() {
  mentionState = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  dom.fileMentionMenu.hidden = true;
  dom.fileMentionMenu.innerHTML = '';
}

function getMentionContext(text, cursor) {
  const before = text.slice(0, cursor);
  const atIndex = before.lastIndexOf('@');
  if (atIndex < 0) return null;

  const prefix = before.slice(0, atIndex);
  if (atIndex > 0 && !/[\s([{]/.test(prefix.slice(-1))) return null;

  const query = before.slice(atIndex + 1);
  if (/[\s@]/.test(query)) return null;

  return { atIndex, query, cursor };
}

function renderMentionMenu(items, activeIndex) {
  if (!items.length) {
    dom.fileMentionMenu.innerHTML = '<div class="file-mention-empty">No matching files</div>';
    dom.fileMentionMenu.hidden = false;
    return;
  }

  dom.fileMentionMenu.innerHTML = items.map((item, index) => `
    <button
      type="button"
      class="file-mention-item${index === activeIndex ? ' active' : ''}"
      data-index="${index}"
      data-path="${item.path.replace(/"/g, '&quot;')}"
    >
      <span class="file-mention-item-path">${escapeHtml(item.path)}</span>
      <span class="file-mention-item-dir">${escapeHtml(item.directory)}</span>
    </button>
  `).join('');
  dom.fileMentionMenu.hidden = false;

  const activeEl = dom.fileMentionMenu.querySelector('.file-mention-item.active');
  activeEl?.scrollIntoView({ block: 'nearest' });
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchMentionResults(query) {
  const requestId = ++searchRequestId;
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  params.set('limit', String(MAX_RESULTS));
  const result = await api('GET', `/api/v1/workspace/files?${params.toString()}`);
  if (requestId !== searchRequestId) return null;
  return Array.isArray(result.files) ? result.files : [];
}

function scheduleMentionSearch(context) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    debounceTimer = null;
    if (!mentionState || mentionState.atIndex !== context.atIndex) return;

    try {
      const files = await fetchMentionResults(context.query);
      if (!mentionState || mentionState.atIndex !== context.atIndex) return;
      mentionState.items = files;
      mentionState.activeIndex = files.length ? 0 : -1;
      renderMentionMenu(files, mentionState.activeIndex);
    } catch (err) {
      dom.fileMentionMenu.innerHTML = `<div class="file-mention-empty">${escapeHtml(err.message || String(err))}</div>`;
      dom.fileMentionMenu.hidden = false;
    }
  }, DEBOUNCE_MS);
}

function openMentionMenu(context) {
  mentionState = {
    atIndex: context.atIndex,
    query: context.query,
    cursor: context.cursor,
    items: [],
    activeIndex: -1,
  };
  dom.fileMentionMenu.innerHTML = '<div class="file-mention-empty">Searching…</div>';
  dom.fileMentionMenu.hidden = false;
  scheduleMentionSearch(context);
}

function insertMention(path) {
  const input = dom.msgInput;
  const text = input.value;
  const cursor = input.selectionStart ?? text.length;
  const context = mentionState || getMentionContext(text, cursor);
  if (!context) return;

  const before = text.slice(0, context.atIndex);
  const after = text.slice(context.cursor);
  const mention = `@${path}`;
  const next = `${before}${mention} ${after}`;
  const nextCursor = before.length + mention.length + 1;

  input.value = next;
  input.setSelectionRange(nextCursor, nextCursor);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  closeMentionMenu();
  input.focus();
}

function moveMentionSelection(delta) {
  if (!mentionState?.items?.length) return false;
  const count = mentionState.items.length;
  const current = mentionState.activeIndex < 0 ? 0 : mentionState.activeIndex;
  mentionState.activeIndex = (current + delta + count) % count;
  renderMentionMenu(mentionState.items, mentionState.activeIndex);
  return true;
}

function acceptMentionSelection() {
  if (!mentionState?.items?.length || mentionState.activeIndex < 0) return false;
  const selected = mentionState.items[mentionState.activeIndex];
  if (!selected?.path) return false;
  insertMention(selected.path);
  return true;
}

function handleInput() {
  const input = dom.msgInput;
  const text = input.value;
  const cursor = input.selectionStart ?? text.length;
  const context = getMentionContext(text, cursor);

  if (!context) {
    closeMentionMenu();
    return;
  }

  if (mentionState && mentionState.atIndex === context.atIndex && mentionState.query === context.query) {
    mentionState.cursor = context.cursor;
    return;
  }

  openMentionMenu(context);
}

export function bindFileMentionController() {
  dom.msgInput.addEventListener('input', handleInput);
  dom.msgInput.addEventListener('click', handleInput);
  dom.msgInput.addEventListener('keyup', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      handleInput();
    }
  });
  dom.msgInput.addEventListener('blur', () => {
    setTimeout(() => closeMentionMenu(), 120);
  });

  dom.fileMentionMenu.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  dom.fileMentionMenu.addEventListener('click', (event) => {
    const button = event.target.closest('.file-mention-item');
    if (!button) return;
    insertMention(button.dataset.path);
  });

  dom.msgInput.addEventListener('keydown', (event) => {
    if (mentionState && !dom.fileMentionMenu.hidden) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveMentionSelection(1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveMentionSelection(-1);
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && mentionState.items.length)) {
        if (acceptMentionSelection()) {
          event.preventDefault();
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitMessageFromInput();
    }
  });
}

export function submitMessageFromInput() {
  closeMentionMenu();
  sendMessage(dom.msgInput.value);
}
