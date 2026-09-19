/**
 * What the node library actually puts in front of the user.
 *
 * `userPlaceable` is checked against the registry next door
 * ([nodeLibrary.test.ts](../engine/graph/nodeLibrary.test.ts)); this is the
 * other half — that the panel reads the flag rather than the category, so the
 * encoder, the three source kinds and the internal `__tap` are gone from the
 * rows and `outputColorSpace` is in them (F019), and that a node needing a
 * file says so before it is dropped (F074).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { NodeLibraryPanel } from './NodeLibraryPanel';
import { nodeKindLabel } from '../engine/graph';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];
afterEach(() => { while (mounted.length) mounted.pop()!(); });

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

/**
 * The rows the panel renders for a search. Searching is also what forces every
 * section open, so a collapsed one cannot hide a kind from this test.
 */
function rows(search: string): string[] {
  const host = document.createElement('div');
  host.style.cssText = 'width:220px;height:900px;position:fixed;top:0;left:0;';
  document.body.appendChild(host);
  let root: Root;
  act(() => {
    root = createRoot(host);
    root.render(createElement(NodeLibraryPanel));
  });
  mounted.push(() => { act(() => root.unmount()); host.remove(); });
  const input = host.querySelector<HTMLInputElement>('input[type=text]')!;
  act(() => {
    nativeValueSetter.call(input, search);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return [...host.querySelectorAll<HTMLElement>('[draggable=true]')].map((el) => el.textContent ?? '');
}

describe('node library rows', () => {
  it('lists the kinds a user can drop and no others', () => {
    // An empty filter leaves the collapsed sections collapsed, so search for
    // the one letter every kind label has.
    const visible = rows('e').concat(rows('a')).concat(rows('o'));
    const has = (kind: string) => visible.some((row) => row.startsWith(nodeKindLabel(kind)));

    expect(has('tone')).toBe(true);
    expect(has('customLut')).toBe(true);
    expect(has('preview')).toBe(true);
    // The kind a Delete used to take for good.
    expect(has('outputColorSpace')).toBe(true);

    // No shader, no bound pixels, no user-facing tap.
    expect(has('__encoder.multiOutput')).toBe(false);
    expect(has('__source.imageBitmap')).toBe(false);
    expect(has('__source.raw16')).toBe(false);
    expect(has('__source.rasterizedMask')).toBe(false);
    expect(has('__tap')).toBe(false);
    expect(has('__convert.linToGamma')).toBe(false);
  });

  it('marks the node that needs a file before it does anything', () => {
    const lut = rows('lut').find((row) => row.startsWith(nodeKindLabel('customLut')));
    expect(lut).toBeDefined();
    expect(lut).toContain('graphEditor.library.needsFile');

    const tone = rows('tone').find((row) => row.startsWith(nodeKindLabel('tone')));
    expect(tone).toBeDefined();
    expect(tone).not.toContain('graphEditor.library.needsFile');
  });

  it('renders nothing at all for a search that matches no placeable kind', () => {
    expect(rows('__encoder')).toEqual([]);
    expect(rows('__source')).toEqual([]);
  });
});
