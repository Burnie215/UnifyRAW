export class LibraryRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'LibraryRequestError';
  }
}

