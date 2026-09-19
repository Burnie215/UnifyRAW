import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initDb, markDirty, persistSoon, saveToFile } from './db.js';

let temporaryRoot: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  closeDb();
  if (temporaryRoot) {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = null;
  }
});

describe('database persistence', () => {
  it('atomically replaces the database file and survives reopening', async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-'));
    const filePath = path.join(temporaryRoot, 'photolib.sqlite');
    await initDb(filePath);
    getDb().run('CREATE TABLE persistence_probe (value TEXT NOT NULL)');
    // Accounts and libraries write without markDirty; the save must see it anyway.
    getDb().run('INSERT INTO persistence_probe (value) VALUES (?)', ['durable']);

    saveToFile();

    const entries = await fs.readdir(temporaryRoot);
    expect(entries).toEqual(['photolib.sqlite']);
    expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await valuesOnDisk(filePath)).toEqual(['durable']);

    closeDb();
    await initDb(filePath);
    const result = getDb().exec('SELECT value FROM persistence_probe');
    expect(result[0]?.values).toEqual([['durable']]);
  });

  it('leaves the file untouched when nothing changed since the last save', async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-'));
    const filePath = path.join(temporaryRoot, 'photolib.sqlite');
    await initDb(filePath);
    const before = await fs.stat(filePath);

    saveToFile();
    await persistSoon();

    const after = await fs.stat(filePath);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });

  it('writes one snapshot for saves requested before it is taken', async () => {
    const filePath = await databaseWithProbeTable();
    const exportSpy = vi.spyOn(getDb(), 'export');

    getDb().run("INSERT INTO persistence_probe (value) VALUES ('first')");
    markDirty();
    const first = persistSoon();
    getDb().run("INSERT INTO persistence_probe (value) VALUES ('second')");
    markDirty();
    const second = persistSoon();
    await Promise.all([first, second]);

    expect(exportSpy).toHaveBeenCalledTimes(1);
    expect(await valuesOnDisk(filePath)).toEqual(['first', 'second']);
  });

  it('makes saves requested during a running write share the next snapshot', async () => {
    const filePath = await databaseWithProbeTable();
    const exportSpy = vi.spyOn(getDb(), 'export');
    const realOpen = fs.open.bind(fs);
    let late: Array<Promise<void>> = [];
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      getDb().run("INSERT INTO persistence_probe (value) VALUES ('late')");
      markDirty();
      late = [persistSoon(), persistSoon()];
      return realOpen(...args);
    });

    getDb().run("INSERT INTO persistence_probe (value) VALUES ('early')");
    markDirty();
    await persistSoon();
    expect(await valuesOnDisk(filePath)).toEqual(['early']);

    expect(late).toHaveLength(2);
    expect(late[0]).toBe(late[1]);
    await late[0];
    expect(exportSpy).toHaveBeenCalledTimes(2);
    expect(await valuesOnDisk(filePath)).toEqual(['early', 'late']);
  });

  it('never lets an older snapshot replace a newer one written meanwhile', async () => {
    const filePath = await databaseWithProbeTable();
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      getDb().run("INSERT INTO persistence_probe (value) VALUES ('synchronous')");
      saveToFile();
      return realOpen(...args);
    });

    getDb().run("INSERT INTO persistence_probe (value) VALUES ('queued')");
    markDirty();
    await persistSoon();

    expect(await valuesOnDisk(filePath)).toEqual(['queued', 'synchronous']);
    expect(await fs.readdir(path.dirname(filePath))).toEqual(['photolib.sqlite']);
  });
});

async function databaseWithProbeTable(): Promise<string> {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'photolib-db-'));
  const filePath = path.join(temporaryRoot, 'photolib.sqlite');
  await initDb(filePath);
  getDb().run('CREATE TABLE persistence_probe (value TEXT NOT NULL)');
  saveToFile();
  return filePath;
}

async function valuesOnDisk(filePath: string): Promise<unknown[]> {
  const SQL = await initSqlJs();
  const onDisk = new SQL.Database(await fs.readFile(filePath));
  try {
    return onDisk.exec('SELECT value FROM persistence_probe ORDER BY rowid')[0]?.values.map((row) => row[0]) ?? [];
  } finally {
    onDisk.close();
  }
}
