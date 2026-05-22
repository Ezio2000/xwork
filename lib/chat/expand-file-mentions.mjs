import { resolveWorkspaceFilePath } from '../workspace-files.mjs';

/** Align with public/js/renderers.js FILE_MENTION_DISPLAY_RE */
export const FILE_MENTION_RE = /(?:^|[\s([{])@([A-Za-z0-9_./\-]+)/g;

function collectMentions(text) {
  const mentions = [];
  const re = new RegExp(FILE_MENTION_RE.source, FILE_MENTION_RE.flags);
  let match;
  while ((match = re.exec(text)) !== null) {
    mentions.push({
      index: match.index,
      fullMatch: match[0],
      path: match[1],
    });
  }
  return mentions;
}

function formatResolvedHint(resolved) {
  return `(workspace file: relative path \`${resolved.relativePath}\`, absolute path \`${resolved.absolutePath}\`)`;
}

function formatUnresolvedHint(path, err) {
  const reason = err?.message || String(err);
  return `(workspace file @${path}: could not resolve — ${reason})`;
}

export async function expandFileMentionsInText(text, { resolvePath = resolveWorkspaceFilePath } = {}) {
  if (typeof text !== 'string' || !text.includes('@')) return text;

  const mentions = collectMentions(text);
  if (!mentions.length) return text;

  const hintByPath = new Map();
  await Promise.all(mentions.map(async ({ path }) => {
    if (hintByPath.has(path)) return;
    try {
      const resolved = await resolvePath(path);
      hintByPath.set(path, formatResolvedHint(resolved));
    } catch (err) {
      hintByPath.set(path, formatUnresolvedHint(path, err));
    }
  }));

  let result = text;
  for (let i = mentions.length - 1; i >= 0; i -= 1) {
    const { index, fullMatch, path } = mentions[i];
    const hint = hintByPath.get(path);
    const replacement = `${fullMatch} ${hint}`;
    result = result.slice(0, index) + replacement + result.slice(index + fullMatch.length);
  }
  return result;
}

export async function expandFileMentionsInContent(content, options = {}) {
  if (typeof content === 'string') {
    return expandFileMentionsInText(content, options);
  }
  if (!Array.isArray(content)) return content;

  const next = await Promise.all(content.map(async (block) => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      const text = await expandFileMentionsInText(block.text, options);
      if (text !== block.text) return { ...block, text };
    }
    return block;
  }));

  return next.some((block, index) => block !== content[index]) ? next : content;
}

export async function expandFileMentionsInHistory(history, options = {}) {
  if (!Array.isArray(history) || !history.length) return history;

  const expanded = [];
  let changed = false;

  for (const message of history) {
    if (message?.role !== 'user') {
      expanded.push(message);
      continue;
    }

    const nextContent = await expandFileMentionsInContent(message.content, options);
    if (nextContent !== message.content) {
      changed = true;
      expanded.push({ ...message, content: nextContent });
    } else {
      expanded.push(message);
    }
  }

  return changed ? expanded : history;
}
