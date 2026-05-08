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
