import { describe, expect, it, vi } from 'vitest';
import { decidePushToSource, type PushSourceInfo } from './pushToSource';

const SOURCES: Record<string, PushSourceInfo> = {
  immich: { writable: true, label: 'Immich' },
  lychee: { writable: true, label: 'Lychee' },
  folder: { writable: false, label: 'Bilder' },
  usb: { writable: false, label: 'USB-Stick' },
};
const describeSource = (id: string): PushSourceInfo | null => SOURCES[id] ?? null;

const photo = (sourceId: string) => ({ sourceId });

describe('decidePushToSource', () => {
  it('refuses an empty selection', () => {
    expect(decidePushToSource([], describeSource)).toEqual({ canPush: false, reason: 'no-photos' });
  });

  it('allows the open photo on a writable source', () => {
    expect(decidePushToSource([photo('immich')], describeSource))
      .toEqual({ canPush: true, sourceId: 'immich', label: 'Immich' });
  });

  it('allows a whole selection that shares one writable source', () => {
    const many = Array.from({ length: 5 }, () => photo('immich'));
    expect(decidePushToSource(many, describeSource))
      .toEqual({ canPush: true, sourceId: 'immich', label: 'Immich' });
  });

  it('refuses a mixed selection even when every source could write', () => {
    expect(decidePushToSource([photo('immich'), photo('lychee')], describeSource))
      .toEqual({ canPush: false, reason: 'mixed-sources' });
  });

  it('refuses a mixed selection wherever the foreign photo sits', () => {
    const trailing = [photo('immich'), photo('immich'), photo('folder')];
    const leading = [photo('folder'), photo('immich'), photo('immich')];
    for (const selection of [trailing, leading]) {
      expect(decidePushToSource(selection, describeSource))
        .toEqual({ canPush: false, reason: 'mixed-sources' });
    }
  });

  it('refuses a source that cannot write back', () => {
    expect(decidePushToSource([photo('folder'), photo('folder')], describeSource))
      .toEqual({ canPush: false, reason: 'source-read-only' });
  });

  it('calls a mixed selection of read-only sources read-only, not mixed', () => {
    expect(decidePushToSource([photo('folder'), photo('usb')], describeSource))
      .toEqual({ canPush: false, reason: 'source-read-only' });
  });

  it('refuses a source it knows nothing about', () => {
    expect(decidePushToSource([photo('gone')], describeSource))
      .toEqual({ canPush: false, reason: 'source-read-only' });
  });

  it('asks about each source once, however long the selection is', () => {
    const spy = vi.fn(describeSource);
    const many = [...Array.from({ length: 50 }, () => photo('immich')), photo('folder')];
    decidePushToSource(many, spy);
    expect(spy.mock.calls.map(([id]) => id)).toEqual(['immich', 'folder']);
  });
});
