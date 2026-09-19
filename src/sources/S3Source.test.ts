import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Source } from './S3Source';

const { proxyFetch } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
}));

vi.mock('../platform/api', () => ({ proxyFetch }));

describe('S3Source authentication', () => {
  beforeEach(() => {
    proxyFetch.mockReset();
    proxyFetch.mockResolvedValue({ ok: true } as Response);
  });

  it('fails closed before sending a request while SigV4 is unavailable', async () => {
    const source = new S3Source('s3', 'S3', {
      endpoint: 'https://s3.example.test',
      bucket: 'photos',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
    });

    await expect(source.connect()).resolves.toBe(false);
    expect(proxyFetch).not.toHaveBeenCalled();
  });
});
