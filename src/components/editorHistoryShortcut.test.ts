import { describe, expect, it } from 'vitest';

import { editorHistoryShortcut } from './editorHistoryShortcut';

function key(overrides: Partial<Parameters<typeof editorHistoryShortcut>[0]> = {}) {
  return {
    key: 'z',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  };
}

describe('editor history shortcut', () => {
  it('owns undo and redo outside text fields', () => {
    expect(editorHistoryShortcut(key())).toBe('undo');
    expect(editorHistoryShortcut(key({ shiftKey: true }))).toBe('redo');
    expect(editorHistoryShortcut(key({ ctrlKey: false, metaKey: true }))).toBe('undo');
  });

  it.each(['input', 'textarea'])('leaves Ctrl-Z in a %s to the browser', (tagName) => {
    expect(editorHistoryShortcut(key({ target: { tagName } as unknown as EventTarget }))).toBeNull();
  });

  it('leaves undo in contenteditable text to the browser', () => {
    const target = { tagName: 'div', isContentEditable: true } as unknown as EventTarget;
    expect(editorHistoryShortcut(key({ target }))).toBeNull();
  });

  it('ignores unrelated keys', () => {
    expect(editorHistoryShortcut(key({ key: 'x' }))).toBeNull();
    expect(editorHistoryShortcut(key({ ctrlKey: false }))).toBeNull();
  });
});
