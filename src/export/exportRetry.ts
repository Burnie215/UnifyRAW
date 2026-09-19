import { ExportError } from './ExportError';

export const EXPORT_MAX_ATTEMPTS = 3;
export const EXPORT_RETRY_BASE_DELAY_MS = 250;

export function isRetryableExportError(error: unknown): boolean {
  return error instanceof ExportError && (error.code === 'server' || error.code === 'network');
}

export interface ExportRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

const defaultSleep = (delayMs: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, delayMs);
});

/** Retries transient export failures only, with exponential backoff. */
export async function retryExport<T>(
  operation: () => Promise<T>,
  options: ExportRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? EXPORT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? EXPORT_RETRY_BASE_DELAY_MS;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !isRetryableExportError(error)) throw error;
      await sleep(baseDelayMs * (2 ** (attempt - 1)));
    }
  }
}
