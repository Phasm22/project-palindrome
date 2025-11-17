import type { AccessDeniedMetadata } from "./types";

export class AccessDeniedError extends Error {
  readonly code = "ACCESS_DENIED";
  readonly statusCode = 403;
  readonly details: AccessDeniedMetadata;

  constructor(details: AccessDeniedMetadata, message: string = "ACCESS_DENIED") {
    super(message);
    this.name = "AccessDeniedError";
    this.details = details;
  }
}
