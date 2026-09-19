import { describe, expect, it } from 'vitest';
import { createFakeDirectory, fakeFileHandle, readFakeFile } from '../test/fakeFileSystem';
import { ThumbBinStore, type ThumbBinLocator } from './ThumbBinStore';

const PREFIX = 4;
const LENGTH = 8;
const jpeg = (fill: number) => new Uint8Array(LENGTH).fill(fill);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setup() {
  const root = createFakeDirectory();
  const store = new ThumbBinStore(await root.getDirectoryHandle('thumbs', { create: true }));
  // Stands in for thumbIndex: what the catalog believes is where.
  const index = new Map<string, ThumbBinLocator>();
  const listEntries = () => [...index].map(([hash, loc]) => ({ hash, offset: loc.offset, length: loc.length }));
  const applyIndex = (entries: Array<{ hash: string; loc: ThumbBinLocator }>) => {
    for (const { hash, loc } of entries) index.set(hash, loc);
  };
  const append = async (hash: string, fill: number, indexed = true) => {
    const loc = await store.append(hash, 'small', new Blob([jpeg(fill)]));
    if (indexed) index.set(hash, loc);
    return loc;
  };
  const readBack = async (hash: string) => {
    const blob = await store.read(index.get(hash)!, 'small');
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  };
  const binSize = async () => (await readFakeFile(root, 'thumbs/small/ab.bin'))?.size ?? 0;
  return { root, store, index, listEntries, applyIndex, append, readBack, binSize };
}

/** Holds the compaction's rewrite (the one writable that does not keep existing data). */
async function holdRewrite(root: FileSystemDirectoryHandle) {
  let reached!: () => void;
  let release!: () => void;
  const atGate = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (await fakeFileHandle(root, 'thumbs/small/ab.bin')).beforeCreateWritable = async (options) => {
    if (options?.keepExistingData) return;
    reached();
    await gate;
  };
  return { atGate, release };
}

describe('ThumbBinStore.compactBin', () => {
  it('lets an append that arrives mid-compaction wait and land behind the rewritten records', async () => {
    const t = await setup();
    await t.append('ab01', 1);
    await t.append('abff', 9, false); // never indexed: the slack compaction reclaims
    await t.append('ab02', 2);
    expect(await t.binSize()).toBe(3 * (PREFIX + LENGTH));

    const held = await holdRewrite(t.root);
    const compaction = t.store.compactBin('small', 'ab', t.listEntries, t.applyIndex);
    await held.atGate;
    const late = t.append('ab03', 3);
    await sleep(10);
    held.release();
    const [result] = await Promise.all([compaction, late]);

    expect(result).toEqual({ before: 3 * (PREFIX + LENGTH), after: 2 * (PREFIX + LENGTH), skipped: false, dropped: [] });
    expect(await t.readBack('ab01')).toEqual(jpeg(1));
    expect(await t.readBack('ab02')).toEqual(jpeg(2));
    expect(await t.readBack('ab03')).toEqual(jpeg(3));
    expect(await t.binSize()).toBe(3 * (PREFIX + LENGTH));
  });

  it('skips a bin without slack and drops index entries that point past its end', async () => {
    const t = await setup();
    await t.append('ab01', 1);
    await t.append('ab02', 2);
    t.index.set('ab77', { binId: 'ab', offset: 500, length: LENGTH });

    const result = await t.store.compactBin('small', 'ab', t.listEntries, t.applyIndex);
    expect(result).toEqual({ before: 2 * (PREFIX + LENGTH), after: 2 * (PREFIX + LENGTH), skipped: true, dropped: ['ab77'] });
    expect(await t.readBack('ab02')).toEqual(jpeg(2));
  });
});
