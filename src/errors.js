/**
 * Structured API error with status, code, and optional details.
 */
export class ApiError extends Error {
  /**
   * @param {number} status  HTTP-like status code
   * @param {string} code    Machine-readable error code
   * @param {string} message Human-readable description
   * @param {object} [details] Additional context
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class RateLimitError extends ApiError {
  constructor(message, details = {}) {
    super(429, "RATE_LIMITED", message, details);
    this.name = "RateLimitError";
    this.retryAfter = details.retryAfter ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}
