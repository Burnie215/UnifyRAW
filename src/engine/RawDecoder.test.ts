import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

/**
 * What the decoder must guarantee, whatever libraw-wasm does underneath: every
 * call settles, and the worker is let go afterwards.
 *
 * 1.1.2 guaranteed neither. It parked a call's promise as
 * `{ error: reject, return: resolve }` and read it back as `{ return, throw }`,
 * so an error reply called `undefined` and the decode hung for the life of the
 * tab - holding one of two RAW slots and one of six thumbnail queue slots, and
 * with six such files the grid stopped loading anything and the background pass
 * stopped writing blur hashes. 1.6.0 rejects properly; these tests hold the
 * line it fixed, and cover the case no library version can rule out: a worker
 * that answers nothing at all.
 */
type Mode = 'ok' | 'error' | 'silent';
let mode: Mode = 'ok';
let disposed = 0;

class FakeLibRaw {
  worker = { terminate() { /* 1.6.0 disposes instead */ } };
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 0;

  dispose() {
    disposed++;
    for (const { reject } of this.pending.values()) reject(new Error('LibRaw disposed'));
    this.pending.clear();
  }

  private runFn(out: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (mode === 'silent') return;
      queueMicrotask(() => {
        const slot = this.pending.get(id);
        if (!slot) return;
        this.pending.delete(id);
        if (mode === 'error') slot.reject(new Error('Unsupported file format or not RAW file'));
        else slot.resolve(out);
      });
    });
  }

  open() { return this.runFn(undefined) as Promise<void>; }
  metadata() { return this.runFn({ desc: 'FUJIFILM X-T5', width: 4, height: 4 }) as Promise<Record<string, unknown>>; }
  imageData() {
    return this.runFn({ data: new Uint8Array(12), width: 2, height: 2, colors: 3, bits: 8, dataSize: 12 }) as Promise<never>;
  }
}

vi.mock('libraw-wasm', () => ({ default: FakeLibRaw }));

const { rawDecoder } = await import('./RawDecoder');
const rawFile = () => new File([new Uint8Array(64)], 'M5CF1100.RAF');

describe('RawDecoder never leaves a decode pending', () => {
  beforeEach(() => { disposed = 0; mode = 'ok'; });
  afterEach(() => { vi.useRealTimers(); });

  it('passes a decoded frame through', async () => {
    const image = await rawDecoder.decode(rawFile());
    expect(image.width).toBe(2);
    expect(image.height).toBe(2);
    expect(image.data.length).toBe(12);
    expect(image.metadata.model).toBe('FUJIFILM X-T5');
  });

  it('rejects a file libraw refuses, rather than hanging on it', async () => {
    mode = 'error';
    const settled = await Promise.race([
      rawDecoder.decode(rawFile()).then(() => 'resolved', (e: Error) => e.message),
      new Promise<string>((r) => setTimeout(() => r('STILL PENDING'), 500)),
    ]);
    expect(settled).not.toBe('STILL PENDING');
    expect(settled).toContain('Unsupported file format');
  });

  it('gives the worker back after a success and after a failure', async () => {
    await rawDecoder.decode(rawFile());
    expect(disposed).toBe(1);
    mode = 'error';
    await expect(rawDecoder.decode(rawFile())).rejects.toThrow();
    expect(disposed).toBe(2);
  });

  it('gives up on a worker that answers nothing at all, naming the file', async () => {
    mode = 'silent';
    vi.useFakeTimers();
    const decoding = rawDecoder.decode(rawFile());
    const outcome = decoding.then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(180_000);
    await expect(outcome).resolves.toContain('M5CF1100.RAF');
    expect(disposed).toBe(1);
  });
});
