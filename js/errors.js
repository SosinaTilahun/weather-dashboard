// Error types and helpers shared by every module.

/** Thrown when the server answers with a non-2xx status. */
export class HttpError extends Error {
  constructor(status, statusText, url) {
    super(`HTTP ${status}${statusText ? ' ' + statusText : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

/** The final error the UI sees after retries are exhausted (or a request is not retryable). */
export class WeatherApiError extends Error {
  /**
   * @param {string} message human readable message
   * @param {{kind: 'http'|'network'|'timeout'|'parse'|'notfound'|'unknown', attempts?: number, status?: number, cause?: unknown}} info
   */
  constructor(message, { kind, attempts = 1, status, cause } = {}) {
    super(message, { cause });
    this.name = 'WeatherApiError';
    this.kind = kind;
    this.attempts = attempts;
    this.status = status;
  }
}

/** Creates the same error fetch() rejects with when an AbortController fires. */
export function createAbortError(message = 'The request was cancelled.') {
  return new DOMException(message, 'AbortError');
}

/** True for cancellations (user cancel / stale request). A timeout is NOT an abort. */
export function isAbortError(err) {
  return err?.name === 'AbortError';
}

/**
 * Decides whether a failed attempt is worth retrying.
 *  - network failures (fetch rejects with TypeError) -> yes
 *  - timeouts                                         -> yes
 *  - HTTP 5xx, 429 (rate limit), 408 (timeout)        -> yes
 *  - other 4xx (bad request, not found)               -> no, retrying cannot help
 *  - cancellations and parse errors                   -> no
 */
export function isRetryable(err) {
  if (isAbortError(err)) return false;
  if (err instanceof HttpError) {
    return err.status >= 500 || err.status === 429 || err.status === 408;
  }
  if (err?.name === 'TimeoutError') return true;
  if (err instanceof TypeError) return true;
  return false;
}
