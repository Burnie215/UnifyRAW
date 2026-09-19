/**
 * In-memory File System Access API for node tests. Covers what the storage
 * code uses: directory/file lookup with `{ create }`, removeEntry, async
 * iteration, getFile() snapshots and writables that commit on close().
 * Missing entries throw DOMException 'NotFoundError', like the browser.
 */

type FakeEntry = FakeDirectoryHandle | FakeFileHandle;

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

function assertValidName(name: string): void {
  if (name === '' || name === '.' || name === '..' || name.includes('/')) {
    throw new TypeError(`invalid entry name: ${JSON.stringify(name)}`);
  }
}

async function toBytes(data: BufferSource | Blob | string): Promise<Uint8Array> {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  return new Uint8Array(data).slice();
}

function isWriteParams(chunk: FileSystemWriteChunkType): chunk is WriteParams {
  return typeof chunk === 'object' && chunk !== null && !(chunk instanceof Blob)
    && !ArrayBuffer.isView(chunk) && !(chunk instanceof ArrayBuffer) && 'type' in chunk;
}

class FakeWritable {
  private buffer: Uint8Array;
  private position = 0;
  private closed = false;
  private readonly target: FakeFileHandle;

  constructor(target: FakeFileHandle, initial: Uint8Array) {
    this.target = target;
    this.buffer = initial;
  }

  async write(chunk: FileSystemWriteChunkType): Promise<void> {
    this.assertOpen();
    if (!isWriteParams(chunk)) {
      this.writeAt(this.position, await toBytes(chunk));
      return;
    }
    switch (chunk.type) {
      case 'seek':
        this.position = chunk.position ?? 0;
        return;
      case 'truncate':
        this.resize(chunk.size ?? 0);
        return;
      case 'write':
        if (chunk.data == null) throw new TypeError('write command needs data');
        this.writeAt(chunk.position ?? this.position, await toBytes(chunk.data));
        return;
    }
  }

  async seek(position: number): Promise<void> {
    this.assertOpen();
    this.position = position;
  }

  async truncate(size: number): Promise<void> {
    this.assertOpen();
    this.resize(size);
  }

  async close(): Promise<void> {
    this.assertOpen();
    this.closed = true;
    this.target.commit(this.buffer);
  }

  async abort(): Promise<void> {
    this.closed = true;
  }

  private writeAt(position: number, bytes: Uint8Array): void {
    const end = position + bytes.byteLength;
    if (end > this.buffer.byteLength) this.resize(end, false);
    this.buffer.set(bytes, position);
    this.position = end;
  }

  private resize(size: number, clampPosition = true): void {
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, Math.min(size, this.buffer.byteLength)));
    this.buffer = next;
    if (clampPosition && this.position > size) this.position = size;
  }

  private assertOpen(): void {
    if (this.closed) throw new TypeError('writable stream is closed');
  }
}

export class FakeFileHandle {
  readonly kind = 'file' as const;
  readonly name: string;
  private bytes = new Uint8Array(0);
  private lastModified = Date.now();
  /** Runs before every createWritable: throw to fail it, return a pending promise to hold it. */
  beforeCreateWritable: ((options?: FileSystemCreateWritableOptions) => Promise<void> | void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  async getFile(): Promise<File> {
    return new File([this.bytes.slice()], this.name, { lastModified: this.lastModified });
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    await this.beforeCreateWritable?.(options);
    const initial = options?.keepExistingData ? this.bytes.slice() : new Uint8Array(0);
    return new FakeWritable(this, initial) as unknown as FileSystemWritableFileStream;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (other as unknown) === this;
  }

  commit(bytes: Uint8Array): void {
    this.bytes = bytes.slice();
    this.lastModified = Date.now();
  }
}

export class FakeDirectoryHandle {
  readonly kind = 'directory' as const;
  readonly name: string;
  private readonly children = new Map<string, FakeEntry>();

  constructor(name = '') {
    this.name = name;
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    assertValidName(name);
    const existing = this.children.get(name);
    if (existing instanceof FakeDirectoryHandle) return existing as unknown as FileSystemDirectoryHandle;
    if (existing) throw domError('TypeMismatchError', `${name} is a file`);
    if (!options?.create) throw domError('NotFoundError', `directory ${name} not found`);
    const created = new FakeDirectoryHandle(name);
    this.children.set(name, created);
    return created as unknown as FileSystemDirectoryHandle;
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    assertValidName(name);
    const existing = this.children.get(name);
    if (existing instanceof FakeFileHandle) return existing as unknown as FileSystemFileHandle;
    if (existing) throw domError('TypeMismatchError', `${name} is a directory`);
    if (!options?.create) throw domError('NotFoundError', `file ${name} not found`);
    const created = new FakeFileHandle(name);
    this.children.set(name, created);
    return created as unknown as FileSystemFileHandle;
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    assertValidName(name);
    const existing = this.children.get(name);
    if (!existing) throw domError('NotFoundError', `${name} not found`);
    if (existing instanceof FakeDirectoryHandle && existing.children.size > 0 && !options?.recursive) {
      throw domError('InvalidModificationError', `directory ${name} is not empty`);
    }
    this.children.delete(name);
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return (other as unknown) === this;
  }

  async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
    for (const [name, entry] of [...this.children]) yield [name, entry as unknown as FileSystemHandle];
  }

  async *keys(): AsyncGenerator<string> {
    for (const name of [...this.children.keys()]) yield name;
  }

  async *values(): AsyncGenerator<FileSystemHandle> {
    for (const entry of [...this.children.values()]) yield entry as unknown as FileSystemHandle;
  }

  [Symbol.asyncIterator](): AsyncGenerator<[string, FileSystemHandle]> {
    return this.entries();
  }
}

export function createFakeDirectory(name = ''): FileSystemDirectoryHandle {
  return new FakeDirectoryHandle(name) as unknown as FileSystemDirectoryHandle;
}

/** Reads a file by slash-separated path; null when any segment is missing. */
export async function readFakeFile(root: FileSystemDirectoryHandle, path: string): Promise<File | null> {
  const segments = path.split('/');
  const fileName = segments.pop()!;
  try {
    let dir = root;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
    return await (await dir.getFileHandle(fileName)).getFile();
  } catch (e) {
    if ((e as DOMException).name === 'NotFoundError') return null;
    throw e;
  }
}

/** The fake handle of an existing file by slash-separated path, to script its writables. */
export async function fakeFileHandle(root: FileSystemDirectoryHandle, path: string): Promise<FakeFileHandle> {
  const segments = path.split('/');
  const fileName = segments.pop()!;
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
  return await dir.getFileHandle(fileName) as unknown as FakeFileHandle;
}

export async function listFakeEntries(dir: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const name of (dir as unknown as FakeDirectoryHandle).keys()) names.push(name);
  return names;
}
