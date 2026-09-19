export type EditorHistoryDirection = 'undo' | 'redo';

interface EditorHistoryKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

function isTextEntryTarget(target: EventTarget | null): boolean {
  const editable = target as { tagName?: string; isContentEditable?: boolean } | null;
  const tag = editable?.tagName?.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || editable?.isContentEditable === true;
}

export function editorHistoryShortcut(event: EditorHistoryKey): EditorHistoryDirection | null {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return null;
  if (isTextEntryTarget(event.target)) return null;
  return event.shiftKey ? 'redo' : 'undo';
}
