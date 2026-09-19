import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { depthNoticeFor, deriveEditorSourceDepth, type EditorSourceDepthInput } from './depthFallback';

function input(over: Partial<EditorSourceDepthInput> = {}): EditorSourceDepthInput {
  return {
    isRaw: false,
    rawBits: null,
    rawSource: null,
    isHeif: false,
    heifMode: 'jpeg',
    heifPixels16: false,
    loaded: true,
    ...over,
  };
}

describe('what the editor actually got (F039)', () => {
  it('reports no fallback for a 16-bit smart preview', () => {
    const depth = deriveEditorSourceDepth(input({ isRaw: true, rawBits: 16, rawSource: 'smart-preview' }));
    expect(depth).toEqual({ bits: 16, decodeSource: 'smart-preview', fallback: null });
  });

  it('reports no fallback for a 16-bit libraw-wasm decode', () => {
    const depth = deriveEditorSourceDepth(input({ isRaw: true, rawBits: 16, rawSource: 'libraw-wasm' }));
    expect(depth?.fallback).toBeNull();
    expect(depth?.bits).toBe(16);
  });

  it('names the camera JPEG when the RAW development fell back to it', () => {
    const depth = deriveEditorSourceDepth(input({ isRaw: true, rawBits: 8, rawSource: 'embedded-jpeg' }));
    expect(depth).toEqual({ bits: 8, decodeSource: 'embedded-jpeg', fallback: 'raw-embedded-jpeg' });
  });

  it('separates a real RAW decode that only carries 8 bit from the camera JPEG', () => {
    const depth = deriveEditorSourceDepth(input({ isRaw: true, rawBits: 8, rawSource: 'smart-preview' }));
    expect(depth).toEqual({ bits: 8, decodeSource: 'smart-preview', fallback: 'raw-8bit' });
  });

  it('reports a HEIF that stayed 8-bit although 16-bit linear was asked for', () => {
    const depth = deriveEditorSourceDepth(input({ isHeif: true, heifMode: 'linear16', heifPixels16: false }));
    expect(depth).toEqual({ bits: 8, decodeSource: 'heif-8bit', fallback: 'heif-8bit' });
  });

  it('reports no fallback for a HEIF that delivered 16 bit', () => {
    const depth = deriveEditorSourceDepth(input({ isHeif: true, heifMode: 'linear16', heifPixels16: true }));
    expect(depth).toEqual({ bits: 16, decodeSource: 'heif-linear16', fallback: null });
  });

  it('reports no fallback for a HEIF in a mode that never wanted 16 bit', () => {
    const depth = deriveEditorSourceDepth(input({ isHeif: true, heifMode: 'lossless', heifPixels16: false }));
    expect(depth).toEqual({ bits: 8, decodeSource: 'heif-8bit', fallback: null });
  });

  it('reports a plain JPEG as 8 bit without a fallback', () => {
    expect(deriveEditorSourceDepth(input())).toEqual({ bits: 8, decodeSource: 'image', fallback: null });
  });

  it('says nothing while the image is not on the canvas yet', () => {
    const notLoaded = deriveEditorSourceDepth(
      input({ isRaw: true, rawBits: 8, rawSource: 'embedded-jpeg', loaded: false }),
    );
    expect(notLoaded).toBeNull();
  });

  it('says nothing about a RAW whose decode has not reported yet', () => {
    expect(deriveEditorSourceDepth(input({ isRaw: true }))).toBeNull();
  });
});

describe('the notice the editor shows (AP25 decision 2)', () => {
  const embeddedJpeg = deriveEditorSourceDepth(
    input({ isRaw: true, rawBits: 8, rawSource: 'embedded-jpeg' }),
  );
  const realRaw = deriveEditorSourceDepth(
    input({ isRaw: true, rawBits: 16, rawSource: 'libraw-wasm' }),
  );

  it('is exactly on for a RAW that landed on the camera JPEG', () => {
    expect(depthNoticeFor(embeddedJpeg, 7, null)).toBe('raw-embedded-jpeg');
  });

  it('is exactly off for a real 16-bit decode', () => {
    expect(depthNoticeFor(realRaw, 7, null)).toBeNull();
  });

  it('is off for the photo it was closed for', () => {
    expect(depthNoticeFor(embeddedJpeg, 7, 7)).toBeNull();
  });

  it('is on again for the next photo with a fallback', () => {
    expect(depthNoticeFor(embeddedJpeg, 8, 7)).toBe('raw-embedded-jpeg');
  });

  it('is off while nothing is known yet', () => {
    expect(depthNoticeFor(null, 7, null)).toBeNull();
  });
});

/**
 * Where the notice hangs, checked in the source because nothing else can:
 * PhotoEditor is a 1500-line shell over WebGL, workers and storage, and no test
 * mounts it. The fact under test is structural anyway - the notice used to live
 * inside `editor-image-container`, which the graph mode replaces wholesale, so
 * a RAW opened straight into the node editor (graph-led photos do, AP08) fell
 * back to 8 bit and said nothing. Its inputs never depended on the mode: the
 * depth comes from `useRawImage` and `canvas.loadedPhotoId`, and the latter is
 * set by the worker pipeline, not by the DOM the mode switch swaps.
 */
describe('the notice sits where both render modes see it', () => {
  const source = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../components/PhotoEditor.tsx'),
    'utf8',
  );

  it('has exactly one notice, not one per surface', () => {
    expect(source.match(/<EditorDepthNotice/g)).toHaveLength(1);
  });

  it('renders it before the switch between the node editor and the canvas', () => {
    const notice = source.indexOf('<EditorDepthNotice');
    const modeSwitch = source.indexOf('<EditorModeSurface');
    const canvas = source.indexOf('className={`editor-image-container');

    expect(notice).toBeGreaterThan(-1);
    expect(modeSwitch).toBeGreaterThan(-1);
    expect(canvas).toBeGreaterThan(modeSwitch);
    expect(notice).toBeLessThan(modeSwitch);
  });
});
