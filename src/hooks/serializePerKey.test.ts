import { describe, expect, it } from 'vitest';
import { serializePerKey } from './serializePerKey';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('serializePerKey', () => {
  it('runs two calls with the same key one after the other', async () => {
    const run = serializePerKey();
    const log: string[] = [];
    const gate = deferred();

    const first = run('source-a', async () => { log.push('first:start'); await gate.promise; log.push('first:end'); });
    const second = run('source-a', async () => { log.push('second:start'); });

    await Promise.resolve();
    await Promise.resolve();
    expect(log).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);
    expect(log).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('runs calls with different keys side by side', async () => {
    const run = serializePerKey();
    const log: string[] = [];
    const gate = deferred();

    const first = run('source-a', async () => { log.push('a:start'); await gate.promise; });
    const second = run('source-b', async () => { log.push('b:start'); });

    await second;
    expect(log).toEqual(['a:start', 'b:start']);
    gate.resolve();
    await first;
  });

  it('starts the next call after a predecessor threw, and the caller still sees the error', async () => {
    const run = serializePerKey();
    const failing = run('source-a', async () => { throw new Error('UNIQUE constraint failed'); });
    const next = run('source-a', async () => 'ran');

    await expect(failing).rejects.toThrow('UNIQUE constraint failed');
    await expect(next).resolves.toBe('ran');
  });

  it('forgets a key once its chain is idle', async () => {
    const run = serializePerKey();
    await run('source-a', async () => undefined);
    const log: string[] = [];
    await run('source-a', async () => { log.push('again'); });
    expect(log).toEqual(['again']);
  });
});
