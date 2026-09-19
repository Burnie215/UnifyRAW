import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('source capability documentation', () => {
  it('does not advertise capability rows for retired providers', () => {
    const docs = readFileSync(
      fileURLToPath(new URL('../../docs/source-capabilities.md', import.meta.url)),
      'utf8',
    );
    expect(docs).not.toMatch(/^\| \*\*(?:FTP\/SFTP|SMB)\*\* \|/m);
  });
});
