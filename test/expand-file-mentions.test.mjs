import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  expandFileMentionsInHistory,
  expandFileMentionsInText,
  FILE_MENTION_RE,
} from '../lib/chat/expand-file-mentions.mjs';

describe('expand file mentions', () => {
  it('uses the same mention pattern as the UI renderer', () => {
    assert.equal(FILE_MENTION_RE.source, '(?:^|[\\s([{])@([A-Za-z0-9_./\\-]+)');
  });

  it('appends resolved relative and absolute paths after @mentions', async () => {
    const resolvePath = async (path) => ({
      relativePath: path,
      absolutePath: `D:/Project/AI/xwork/${path}`,
      fileName: path.split('/').pop(),
    });

    const expanded = await expandFileMentionsInText(
      'Please review @lib/workspace-files.mjs',
      { resolvePath },
    );

    assert.match(
      expanded,
      /Please review @lib\/workspace-files\.mjs \(workspace file: relative path `lib\/workspace-files\.mjs`, absolute path `D:\/Project\/AI\/xwork\/lib\/workspace-files\.mjs`\)/,
    );
  });

  it('leaves messages without mentions unchanged', async () => {
    const resolvePath = async () => {
      throw new Error('should not resolve');
    };
    const text = 'No file references here.';
    assert.equal(await expandFileMentionsInText(text, { resolvePath }), text);
  });

  it('records unresolved mentions without throwing', async () => {
    const resolvePath = async () => {
      throw new Error('file does not exist');
    };

    const expanded = await expandFileMentionsInText('Check @missing.txt', { resolvePath });
    assert.match(expanded, /Check @missing\.txt \(workspace file @missing\.txt: could not resolve — file does not exist\)/);
  });

  it('expands only user messages for API history', async () => {
    const resolvePath = async (path) => ({
      relativePath: path,
      absolutePath: `/abs/${path}`,
      fileName: 'f',
    });

    const history = [
      { role: 'assistant', content: 'See @lib/old.mjs' },
      { role: 'user', content: 'Update @package.json' },
    ];

    const expanded = await expandFileMentionsInHistory(history, { resolvePath });
    assert.equal(expanded[0], history[0]);
    assert.notEqual(expanded[1].content, history[1].content);
    assert.match(expanded[1].content, /Update @package\.json \(workspace file:/);
    assert.equal(history[1].content, 'Update @package.json');
  });
});
