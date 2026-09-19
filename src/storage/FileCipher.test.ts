import { describe, expect, it } from 'vitest';
import { webcrypto } from 'crypto';
import { FileCipher } from './FileCipher';

// Node's vitest env doesn't expose global crypto.subtle by default.
if (typeof globalThis.crypto === 'undefined') {
  // @ts-expect-error attach Node webcrypto
  globalThis.crypto = webcrypto;
}

describe('FileCipher', () => {
  it('round-trips arbitrary bytes', async () => {
    const cipher = await FileCipher.fromNewPassphrase('correct horse battery staple');
    const plain = new Uint8Array([1, 2, 3, 4, 5, 99, 250, 0, 7]);
    const sealed = await cipher.encrypt(plain);
    expect(FileCipher.isEncrypted(sealed)).toBe(true);
    const back = await cipher.decrypt(sealed);
    expect(Array.from(back)).toEqual(Array.from(plain));
  });

  it('rejects the wrong passphrase', async () => {
    const c1 = await FileCipher.fromNewPassphrase('s3cret');
    const sealed = await c1.encrypt(new TextEncoder().encode('hello'));
    const salt = FileCipher.extractSalt(sealed);
    const c2 = await FileCipher.fromPassphrase('wrong', salt);
    await expect(c2.decrypt(sealed)).rejects.toThrow();
  });

  it('reopens cleanly with the right passphrase + saved salt', async () => {
    const c1 = await FileCipher.fromNewPassphrase('pw1');
    const sealed = await c1.encrypt(new TextEncoder().encode('reopen me'));
    const salt = FileCipher.extractSalt(sealed);
    const c2 = await FileCipher.fromPassphrase('pw1', salt);
    const back = await c2.decrypt(sealed);
    expect(new TextDecoder().decode(back)).toBe('reopen me');
  });

  it('detects non-envelopes', () => {
    expect(FileCipher.isEncrypted(new Uint8Array([0x53, 0x51, 0x4c, 0x69]))).toBe(false); // 'SQLi'
    expect(FileCipher.isEncrypted(new Uint8Array(2))).toBe(false); // too short
  });
});
