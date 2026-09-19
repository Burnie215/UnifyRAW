import type { Request, Response } from 'express';
import { requestNetworkBuffer } from '../security/network-target.js';

export async function requestNetworkBufferForClient(
  req: Request,
  res: Response,
  url: string,
  options: Parameters<typeof requestNetworkBuffer>[1],
): ReturnType<typeof requestNetworkBuffer> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  if (req.aborted || res.destroyed) abort();

  try {
    return await requestNetworkBuffer(url, { ...options, signal: controller.signal });
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
}
