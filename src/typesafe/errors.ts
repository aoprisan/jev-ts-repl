/**
 * Error types.
 *
 * The hierarchy mirrors the Rust and Python SDKs: configuration and request-validation errors are
 * thrown before anything is sent; {@link ApiError} covers unsuccessful HTTP responses;
 * {@link ConnectionError} and {@link TimeoutError} cover requests that never produced a response;
 * and {@link ResponseValidationError} covers a 2xx response whose body does not match the schema.
 */

import type { Json } from "../json.js";
import { isObject } from "../json.js";
import {
  MAX_ERROR_BODY_LENGTH,
  REQUEST_ID_HEADER,
  RETRY_AFTER_HEADER,
  RETRY_AFTER_MS_HEADER,
} from "./constants.js";

/** Response headers, lowercased. */
export type Headers = Record<string, string>;

/**
 * Marks every {@link TypeSafeError}. A registered symbol, so {@link isTypeSafeError} recognises an
 * error thrown by another copy of the SDK or from another realm, where `instanceof` does not.
 */
const BRAND: unique symbol = Symbol.for("typesafe.error");

/** Any failure produced by the SDK. */
export class TypeSafeError extends Error {
  /**
   * The class name, spelled out so it survives minification. Each subclass declares its own; a
   * field initialiser runs after `super()`, so the most derived class's value wins.
   */
  override readonly name: string = "TypeSafeError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    Object.defineProperty(this, BRAND, { value: true });
  }

  /** The HTTP status associated with this error, if any. */
  get status(): number | undefined {
    return undefined;
  }

  /** The `x-typesafe-request-id` of the failing response, if any. */
  get requestId(): string | undefined {
    return undefined;
  }
}

/**
 * The client could not be configured (missing API key, invalid base URL, invalid timeout,
 * invalid retry policy).
 */
export class ConfigError extends TypeSafeError {
  override readonly name: string = "ConfigError";
}

/**
 * The request was rejected locally before being sent (no questions, empty choice or score
 * criteria, malformed raw question, or a body that cannot be encoded as JSON).
 */
export class InvalidRequestError extends TypeSafeError {
  override readonly name: string = "InvalidRequestError";
}

/** Classification of an unsuccessful HTTP status. */
export type ApiErrorKind =
  | "BadRequest"
  | "Authentication"
  | "PermissionDenied"
  | "NotFound"
  | "UnprocessableEntity"
  | "RateLimit"
  | "InternalServer"
  | "Other";

/** Map a status code to its kind. */
export function apiErrorKind(status: number): ApiErrorKind {
  switch (status) {
    case 400:
      return "BadRequest";
    case 401:
      return "Authentication";
    case 403:
      return "PermissionDenied";
    case 404:
      return "NotFound";
    case 422:
      return "UnprocessableEntity";
    case 429:
      return "RateLimit";
    default:
      return status >= 500 ? "InternalServer" : "Other";
  }
}

/**
 * `true` for any error the SDK throws, including one from another copy of the SDK or another realm
 * (where `instanceof TypeSafeError` is `false`).
 */
export function isTypeSafeError(error: unknown): error is TypeSafeError {
  return (
    typeof error === "object" && error !== null && (error as { [BRAND]?: unknown })[BRAND] === true
  );
}

/**
 * The server returned an unsuccessful HTTP status after any retries.
 *
 * The SDK throws the subclass for the status ({@link RateLimitError} for a 429, and so on), so
 * `instanceof ApiError` catches them all and `kind` still classifies the status.
 */
export class ApiError extends TypeSafeError {
  override readonly name: string = "ApiError";
  /** HTTP status code. */
  readonly httpStatus: number;
  /** Classification of `httpStatus`. */
  readonly kind: ApiErrorKind;
  /** Human-readable message extracted from the body. */
  readonly detail: string;
  /** The JSON error body, the raw text as a string when it is not JSON, or `undefined` when empty. */
  readonly body: Json | undefined;
  /** Response headers. */
  readonly headers: Headers;
  /** `"METHOD url"` without credentials, query or fragment. */
  readonly endpoint: string | undefined;

  constructor(status: number, body: Json | undefined, headers: Headers, endpoint?: string) {
    const extracted = body === undefined ? undefined : extractMessage(body);
    const detail =
      extracted ??
      (body === undefined
        ? "status code (no body)"
        : typeof body === "string"
          ? truncate(body)
          : truncate(JSON.stringify(body) ?? ""));
    const id = headers[REQUEST_ID_HEADER];
    super(
      `${endpoint ? `${endpoint}: ` : ""}${status} ${detail}${id ? ` (request_id=${id})` : ""}`,
    );
    this.httpStatus = status;
    this.kind = apiErrorKind(status);
    this.detail = detail;
    this.body = body;
    this.headers = headers;
    this.endpoint = endpoint;
  }

  override get status(): number {
    return this.httpStatus;
  }

  override get requestId(): string | undefined {
    return this.headers[REQUEST_ID_HEADER];
  }

  /** The wait the server asked for via `retry-after-ms` or `Retry-After`, in milliseconds. */
  retryAfterMs(): number | undefined {
    return parseRetryAfter(this.headers);
  }

  /** The {@link ApiError} subclass for `status`, or a plain `ApiError` for one without its own. */
  static from(
    status: number,
    body: Json | undefined,
    headers: Headers,
    endpoint?: string,
  ): ApiError {
    switch (apiErrorKind(status)) {
      case "BadRequest":
        return new BadRequestError(status, body, headers, endpoint);
      case "Authentication":
        return new AuthenticationError(status, body, headers, endpoint);
      case "PermissionDenied":
        return new PermissionDeniedError(status, body, headers, endpoint);
      case "NotFound":
        return new NotFoundError(status, body, headers, endpoint);
      case "UnprocessableEntity":
        return new UnprocessableEntityError(status, body, headers, endpoint);
      case "RateLimit":
        return new RateLimitError(status, body, headers, endpoint);
      case "InternalServer":
        return new InternalServerError(status, body, headers, endpoint);
      case "Other":
        return new ApiError(status, body, headers, endpoint);
    }
  }
}

/** HTTP 400. */
export class BadRequestError extends ApiError {
  override readonly name: string = "BadRequestError";
}

/** HTTP 401: the API key is missing, malformed or revoked. */
export class AuthenticationError extends ApiError {
  override readonly name: string = "AuthenticationError";
}

/** HTTP 403: the key is valid but not allowed to do this. */
export class PermissionDeniedError extends ApiError {
  override readonly name: string = "PermissionDeniedError";
}

/** HTTP 404. */
export class NotFoundError extends ApiError {
  override readonly name: string = "NotFoundError";
}

/** HTTP 422: the server rejected the request body. */
export class UnprocessableEntityError extends ApiError {
  override readonly name: string = "UnprocessableEntityError";
}

/** HTTP 429. {@link ApiError.retryAfterMs} says how long the server asked to wait. */
export class RateLimitError extends ApiError {
  override readonly name: string = "RateLimitError";
}

/** HTTP 500 or above. */
export class InternalServerError extends ApiError {
  override readonly name: string = "InternalServerError";
}

/**
 * The request could not reach the server or the response could not be read (DNS, connect, TLS,
 * reset, body read). The underlying failure is available as `cause`.
 */
export class ConnectionError extends TypeSafeError {
  override readonly name: string = "ConnectionError";

  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Connection error: ${detail}`, { cause });
  }
}

/** The request exceeded its configured timeout. */
export class TimeoutError extends TypeSafeError {
  override readonly name: string = "TimeoutError";
  /** The per-attempt timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out (timeout=${timeoutMs / 1000}s).`);
    this.timeoutMs = timeoutMs;
  }
}

/** A successful response whose body is missing or has structurally invalid required data. */
export class ResponseValidationError extends TypeSafeError {
  override readonly name: string = "ResponseValidationError";
  /** HTTP status code (2xx). */
  readonly httpStatus: number;
  /** Dotted path to the offending field, e.g. `answers.tone.confidence`. */
  readonly fieldPath: string;
  /** Underlying decoder message. */
  readonly detail: string;
  /** The decoded body (or raw text), if any. */
  readonly body: Json | undefined;
  /** Response headers. */
  readonly headers: Headers;
  /** `"METHOD url"` without credentials, query or fragment. */
  readonly endpoint: string | undefined;

  constructor(
    status: number,
    fieldPath: string,
    detail: string,
    body: Json | undefined,
    headers: Headers,
    endpoint?: string,
  ) {
    const id = headers[REQUEST_ID_HEADER];
    super(
      `${endpoint ? `${endpoint}: ` : ""}${status} Invalid response data at '${fieldPath}': ${detail}` +
        (id ? ` (request_id=${id})` : ""),
    );
    this.httpStatus = status;
    this.fieldPath = fieldPath;
    this.detail = detail;
    this.body = body;
    this.headers = headers;
    this.endpoint = endpoint;
  }

  override get status(): number {
    return this.httpStatus;
  }

  override get requestId(): string | undefined {
    return this.headers[REQUEST_ID_HEADER];
  }
}

function truncate(raw: string): string {
  const chars = [...raw];
  return chars.length > MAX_ERROR_BODY_LENGTH
    ? `${chars.slice(0, MAX_ERROR_BODY_LENGTH).join("")}…`
    : raw;
}

/** Decode an error body leniently: empty → `undefined`, JSON → value, anything else → string. */
export function lenientBody(text: string): Json | undefined {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

/** Pull a human-readable message out of the error shapes the API (FastAPI) may return. */
export function extractMessage(body: Json): string | undefined {
  if (typeof body === "string") return body.length > 0 ? body : undefined;
  if (!isObject(body)) return undefined;

  const error = body["error"];
  if (typeof error === "string") return error;
  if (isObject(error) && typeof error["message"] === "string") return error["message"];

  if (typeof body["message"] === "string") return body["message"];

  const detail = body["detail"];
  if (typeof detail === "string") return detail;
  if (isObject(detail) && typeof detail["message"] === "string") return detail["message"];
  if (Array.isArray(detail)) {
    const parts: string[] = [];
    for (const entry of detail) {
      if (!isObject(entry)) continue;
      const msg = entry["msg"];
      if (typeof msg !== "string") continue;
      const loc = entry["loc"];
      const path = Array.isArray(loc)
        ? loc
            .filter((item) => item !== "body")
            .map((item) => (typeof item === "string" ? item : (JSON.stringify(item) ?? "")))
            .join(".")
        : "";
      parts.push(path.length > 0 ? `${path}: ${msg}` : msg);
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
  return undefined;
}

/** Parse `retry-after-ms` (milliseconds) then `Retry-After` (seconds or HTTP date). */
export function parseRetryAfter(headers: Headers): number | undefined {
  const ms = headers[RETRY_AFTER_MS_HEADER];
  if (ms !== undefined) {
    const raw = ms.trim();
    const value = raw === "" ? 0 : Number(raw);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const raw = headers[RETRY_AFTER_HEADER];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  const seconds = trimmed === "" ? 0 : Number(trimmed);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}
