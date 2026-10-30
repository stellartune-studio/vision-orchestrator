/** Repo-layer errors mapped to HTTP codes by the handler layer. */
export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class BadRequestError extends Error {}
export class UnprocessableError extends Error {}
export class PayloadTooLargeError extends Error {}
