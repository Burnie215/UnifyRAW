export type ExportErrorCode =
  | 'auth'
  | 'conflict'
  | 'too-large'
  | 'quota'
  | 'server'
  | 'network';

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  readonly status?: number;

  constructor(code: ExportErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.status = status;
  }
}

/** Classifies an unsuccessful provider response into a stable UI-facing code. */
export function classifyExportStatus(status: number): ExportErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too-large';
  if (status === 429 || status === 507) return 'quota';
  return 'server';
}

/** Normalises both HTTP and transport failures for a single upload request. */
export async function requestExportResponse(
  provider: string,
  request: () => Promise<Response>,
): Promise<Response> {
  let response: Response;
  try {
    response = await request();
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new ExportError('network', `${provider} upload failed${detail}`);
  }

  if (!response.ok) {
    throw new ExportError(
      classifyExportStatus(response.status),
      `${provider} upload failed: HTTP ${response.status}`,
      response.status,
    );
  }
  return response;
}

export function isExportError(error: unknown): error is ExportError {
  return error instanceof ExportError;
}
