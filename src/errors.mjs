/** Shared API error. `code` is a short machine reason; the message is safe to show. */
export class ZurelayError extends Error {
  constructor(message, { status = 0, code = "", retryAfter = 0 } = {}) {
    super(message);
    this.name = "ZurelayError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}
