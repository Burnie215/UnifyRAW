import { describe, expect, it } from 'vitest';
import { syncTokenUsername } from './syncToken';

function token(payload: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const data = btoa(String.fromCharCode(...bytes))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${data}.signed`;
}

describe('syncTokenUsername', () => {
  it('restores the account name from the persisted Sync-Hub token', () => {
    expect(syncTokenUsername(token({ userId: '1', username: 'alice', exp: 123 }))).toBe('alice');
    expect(syncTokenUsername(token({ userId: '2', username: 'Jörg', exp: 456 }))).toBe('Jörg');
  });

  it('does not invent a name for malformed or unrelated tokens', () => {
    expect(syncTokenUsername(undefined)).toBeNull();
    expect(syncTokenUsername('not-a-token')).toBeNull();
    expect(syncTokenUsername('e30.signature')).toBeNull();
    expect(syncTokenUsername(token({ username: 42 }))).toBeNull();
  });
});
