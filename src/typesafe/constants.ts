/** Environment-variable names, defaults and protocol constants. */

/** Environment variable for the API key. */
export const API_KEY_ENV = "TYPESAFE_API_KEY";
/** Environment variable for the API base URL. */
export const BASE_URL_ENV = "TYPESAFE_BASE_URL";
/** Environment variable for the default model. */
export const DEFAULT_MODEL_ENV = "TYPESAFE_DEFAULT_MODEL";

/** Default API base URL. */
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
/** Default model name. */
export const DEFAULT_MODEL = "jev-latest";
/** Default timeout for each HTTP attempt, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Package version, sent in `User-Agent` and `X-TypeSafe-SDK`. */
export const VERSION = "0.5.0";
/** SDK identifier sent in `User-Agent` and `X-TypeSafe-SDK`. */
export const SDK_NAME = "jev-repl-ts";

export const SYSTEM_ONE_PATH = "/v1/systemone";
export const MODELS_PATH = "/v1/models";

export const MAX_ERROR_BODY_LENGTH = 200;

export const SDK_HEADER = "x-typesafe-sdk";
export const RUNTIME_HEADER = "x-typesafe-runtime";
export const RETRY_COUNT_HEADER = "x-typesafe-retry-count";
export const REQUEST_ID_HEADER = "x-typesafe-request-id";
export const RETRY_AFTER_HEADER = "retry-after";
export const RETRY_AFTER_MS_HEADER = "retry-after-ms";

export const SECRET_HEADERS = [
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
];
