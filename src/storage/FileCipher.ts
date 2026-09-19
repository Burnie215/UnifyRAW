/**
 * Whole-file AES-GCM for catalog.sqlite (Phase 6.5).
 *
 * Wire format of an encrypted blob:
 *   [magic 4B 'PLE1']
 *   [salt 16B]
 *   [iv 12B]
 *   [ciphertext + 16B auth tag]
 *
 * Key is derived via PBKDF2/SHA-256 (600k iterations) from a passphrase
 * and the per-catalog salt. Passphrase is held in memory only; tab-close
 * = lock.
 *
 * Constraints (plan §11/§14):
 *   - In-memory representation of catalog.sqlite stays plain (sql.js
 *     operates on bytes; encrypt-on-flush is the only persistence pass).
 *   - Not combinable with MemoryStorage (no "rest" to encrypt).
 */

const MAGIC = new TextEncoder().encode('PLE1');
const SALT_LEN = 16;
const IV_LEN = 12;
const PBKDF2_ITERATIONS = 600_000;

export class FileCipher {
  private readonly key: CryptoKey;
  private readonly salt: Uint8Array;

  private constructor(key: CryptoKey, salt: Uint8Array) {
    this.key = key;
    this.salt = salt;
  }

  get saltBytes(): Uint8Array { return this.salt; }

  /** Build a cipher from a fresh random salt (use for opt-in encryption). */
  static async fromNewPassphrase(passphrase: string): Promise<FileCipher> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const key = await deriveKey(passphrase, salt);
    return new FileCipher(key, salt);
  }

  /** Build a cipher from an existing salt (use when opening a sealed file). */
  static async fromPassphrase(passphrase: string, salt: Uint8Array): Promise<FileCipher> {
    if (salt.byteLength !== SALT_LEN) throw new Error(`expected ${SALT_LEN}-byte salt, got ${salt.byteLength}`);
    const key = await deriveKey(passphrase, salt);
    return new FileCipher(key, salt);
  }

  /** Returns `[MAGIC | salt | iv | ct+tag]`. */
  async encrypt(plain: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ctBuf = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.key,
      plain as BufferSource,
    );
    const ct = new Uint8Array(ctBuf);
    const out = new Uint8Array(MAGIC.length + SALT_LEN + IV_LEN + ct.byteLength);
    out.set(MAGIC, 0);
    out.set(this.salt, MAGIC.length);
    out.set(iv, MAGIC.length + SALT_LEN);
    out.set(ct, MAGIC.length + SALT_LEN + IV_LEN);
    return out;
  }

  /** Inverse of encrypt(). Throws if magic/salt mismatch or auth-tag check fails. */
  async decrypt(envelope: Uint8Array): Promise<Uint8Array> {
    if (!FileCipher.isEncrypted(envelope)) throw new Error('not a PLE1 envelope');
    const salt = envelope.slice(MAGIC.length, MAGIC.length + SALT_LEN);
    if (!eqBytes(salt, this.salt)) throw new Error('salt mismatch — wrong cipher for this file');
    const iv = envelope.slice(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
    const ct = envelope.slice(MAGIC.length + SALT_LEN + IV_LEN);
    const ptBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      this.key,
      ct as BufferSource,
    );
    return new Uint8Array(ptBuf);
  }

  /** True if the first 4 bytes match the PLE1 magic. */
  static isEncrypted(bytes: Uint8Array): boolean {
    if (bytes.byteLength < MAGIC.length + SALT_LEN + IV_LEN) return false;
    for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
    return true;
  }

  /** Pull the salt out of an envelope without needing the passphrase. */
  static extractSalt(envelope: Uint8Array): Uint8Array {
    if (!FileCipher.isEncrypted(envelope)) throw new Error('not a PLE1 envelope');
    return envelope.slice(MAGIC.length, MAGIC.length + SALT_LEN);
  }
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
