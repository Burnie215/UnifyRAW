import { describe, expect, it, vi } from 'vitest';
import { createCorsOptions, parseAllowedCorsOrigins } from './cors-policy.js';

describe('CORS policy', () => {
  it('defaults to no cross-origin response headers', () => {
    expect(createCorsOptions(new Set())).toEqual({ origin: false });
  });

  it('allows only exact configured origins', () => {
    const options = createCorsOptions(parseAllowedCorsOrigins(
      'https://photo.example, capacitor://localhost/',
    ));
    expect(typeof options.origin).toBe('function');
    const origin = options.origin as Exclude<typeof options.origin, boolean | string | RegExp | unknown[] | undefined>;
    const allowed = vi.fn();
    const denied = vi.fn();

    origin('https://photo.example', allowed);
    origin('https://attacker.example', denied);

    expect(allowed).toHaveBeenCalledWith(null, true);
    expect(denied).toHaveBeenCalledWith(null, false);
  });

  it('rejects wildcard configuration', () => {
    expect(() => parseAllowedCorsOrigins('*')).toThrow('exact origins');
  });
});
