/** The HTTP client. */

import type { Json, JsonObject } from "../json.js";
import { pretty } from "../json.js";
import { cassetteKey, readCassette, writeCassette } from "./cassette.js";
import {
  API_KEY_ENV,
  BASE_URL_ENV,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MODEL_ENV,
  DEFAULT_TIMEOUT_MS,
  MODELS_PATH,
  RECORD_ENV,
  REPLAY_ENV,
  RETRY_COUNT_HEADER,
  RUNTIME_HEADER,
  SDK_HEADER,
  SDK_NAME,
  SYSTEM_ONE_PATH,
  VERSION,
} from "./constants.js";
import {
  ApiError,
  ConfigError,
  ConnectionError,
  type Headers,
  lenientBody,
  ResponseValidationError,
  TimeoutError,
  TypeSafeError,
} from "./errors.js";
import type { Questions } from "./questions.js";
import { questionsToJson, validateQuestions } from "./questions.js";
import type { ListModelsResponse, ResponseMeta, SystemOneResponse } from "./responses.js";
import {
  DecodeFailure,
  decodeModels,
  decodeSystemOne,
  makeSystemOneResponse,
} from "./responses.js";
import type { RetryPolicy } from "./retry.js";
import type { Rubric, RubricQuestions, RubricResponse } from "./rubric.js";
import {
  defaultRetryPolicy,
  isRetryable,
  retryDelayMs,
  shouldStop,
  sleep,
  validateRetryPolicy,
} from "./retry.js";

/** How a {@link Client} is configured. Explicit settings win over environment variables. */
export interface ClientOptions {
  /** API key (else `TYPESAFE_API_KEY`). */
  apiKey?: string;
  /** API root (else `TYPESAFE_BASE_URL`, else `https://api.typesafe.ai`). */
  baseUrl?: string;
  /** Default model (else `TYPESAFE_DEFAULT_MODEL`, else `jev-latest`). */
  model?: string;
  /** Per-attempt timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  /** Default retry policy. */
  retry?: Partial<RetryPolicy>;
  /** Extra headers sent with every request. Authentication and SDK headers cannot be overridden. */
  headers?: Record<string, string>;
  /** Replace the `fetch` implementation (tests, proxies, instrumentation). */
  fetch?: typeof globalThis.fetch;
  /**
   * Write every successful `systemOne` response body to `<dir>/<key>.json` (else
   * `TYPESAFE_RECORD`). Node only.
   */
  record?: string;
  /**
   * Answer `systemOne` from `<dir>/<key>.json` and never touch the network (else
   * `TYPESAFE_REPLAY`). No API key is needed; a request with no recording throws
   * {@link ReplayMissError}. Node only.
   */
  replay?: string;
}

/** Per-call overrides. */
export interface CallOptions {
  /** Override the model for this call. */
  model?: string;
  /** Override the per-attempt timeout for this call. */
  timeoutMs?: number;
  /** Override the retry policy for this call. */
  retry?: Partial<RetryPolicy>;
  /** Add headers for this call (protected headers still win). */
  headers?: Record<string, string>;
  /**
   * Add top-level body fields. A key named `state`, `model` or `questions` replaces the standard
   * field. Useful for API fields this SDK version does not model yet.
   */
  extraBody?: JsonObject;
  /** Abort this call from outside. */
  signal?: AbortSignal;
}

/**
 * Node's environment, or nothing at all. The client runs in a browser too, where `process` does
 * not exist and the key is passed in explicitly.
 */
function env(name: string): string | undefined {
  const source: Record<string, string | undefined> | undefined =
    typeof process === "undefined" ? undefined : process.env;
  const value = source?.[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** What `x-typesafe-runtime` reports. Nothing about the browser but that it is one. */
function runtime(): string {
  if (typeof process !== "undefined" && process.versions?.node !== undefined) {
    return `node ${process.version} (${process.platform}; ${process.arch})`;
  }
  return "browser";
}

/**
 * `error` with the URL's credentials and the key masked in its message and cause chain: fetch
 * refuses a URL with a password in it by quoting the whole URL back.
 */
function withoutSecrets(error: unknown, url: string, authorization: string | undefined): unknown {
  const secrets = new Set<string>();
  const key = authorization?.replace(/^Bearer /, "");
  if (key) secrets.add(key);
  try {
    const u = new URL(url);
    for (const part of [u.password, u.search.slice(1)]) {
      if (part) {
        secrets.add(part);
        secrets.add(decodeURIComponent(part));
      }
    }
  } catch {
    // Not a URL: nothing in it to mask.
  }
  if (secrets.size === 0) return error;
  const mask = (text: string): string => {
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join("***");
    }
    return text;
  };
  const copy = (e: unknown, depth: number): unknown => {
    if (!(e instanceof Error)) return typeof e === "string" ? mask(e) : e;
    const masked = new Error(mask(e.message));
    masked.name = e.name;
    if (e.cause !== undefined && depth < 8) masked.cause = copy(e.cause, depth + 1);
    return masked;
  };
  return copy(error, 0);
}

function checkBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new ConfigError(
      `base_url ${JSON.stringify(url)} is not a valid URL: ${e instanceof Error ? e.message : e}.`,
    );
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    throw new ConfigError(
      `base_url must be an http(s) URL with a host, got ${JSON.stringify(url)}.`,
    );
  }
}

function checkTimeout(ms: number): number {
  if (!(ms > 0) || !Number.isFinite(ms)) {
    throw new ConfigError("timeout must be a positive duration.");
  }
  return ms;
}

/** `"METHOD url"` without credentials, query or fragment. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function headerRecord(headers: globalThis.Headers): Headers {
  const out: Headers = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * TypeSafe API client.
 *
 * ```ts
 * const client = Client.fromEnv();
 * const res = await client.systemOne("The payout failed again.", {
 *   is_urgent: noul("The message conveys urgency"),
 * });
 * console.log(res.noul("is_urgent")?.noul);
 * ```
 */
export class Client {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #retry: RetryPolicy;
  readonly #headers: Record<string, string>;
  readonly #protected: Record<string, string>;
  readonly #fetch: typeof globalThis.fetch;
  readonly #record: string | undefined;
  readonly #replay: string | undefined;

  constructor(options: ClientOptions = {}) {
    // Either option set by hand decides the mode; the environment only speaks when neither is.
    const explicit = options.record !== undefined || options.replay !== undefined;
    const record = explicit ? options.record : env(RECORD_ENV);
    const replay = explicit ? options.replay : env(REPLAY_ENV);
    if (record !== undefined && replay !== undefined) {
      throw new ConfigError(
        explicit
          ? "record and replay cannot both be set: a client either records or replays."
          : `${RECORD_ENV} and ${REPLAY_ENV} cannot both be set: a client either records or replays.`,
      );
    }
    for (const [name, dir] of [
      ["record", record],
      ["replay", replay],
    ] as const) {
      if (dir !== undefined && dir.trim() === "") {
        throw new ConfigError(`${name} must be a directory, got an empty string.`);
      }
    }

    const apiKey = (options.apiKey ?? env(API_KEY_ENV))?.trim() || undefined;
    if (replay === undefined && apiKey === undefined) {
      throw new ConfigError(
        `No API key was provided. Pass apiKey or set the ${API_KEY_ENV} environment variable.`,
      );
    }
    if (apiKey !== undefined && !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new ConfigError(
        "API key must contain only printable ASCII characters without whitespace.",
      );
    }
    const baseUrl = (options.baseUrl ?? env(BASE_URL_ENV) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    checkBaseUrl(baseUrl);
    const retry = { ...defaultRetryPolicy(), ...options.retry };
    validateRetryPolicy(retry);

    this.#baseUrl = baseUrl;
    this.#model = options.model ?? env(DEFAULT_MODEL_ENV) ?? DEFAULT_MODEL;
    this.#timeoutMs = checkTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#retry = retry;
    this.#headers = { ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#record = record;
    this.#replay = replay;
    const ident = `${SDK_NAME}/${VERSION}`;
    this.#protected = {
      authorization: `Bearer ${apiKey ?? ""}`,
      accept: "application/json",
      "user-agent": ident,
      [SDK_HEADER]: ident,
      [RUNTIME_HEADER]: runtime(),
    };
  }

  /** A client configured entirely from the environment. */
  static fromEnv(options: Omit<ClientOptions, "apiKey"> = {}): Client {
    return new Client(options);
  }

  /** The default model. */
  get defaultModel(): string {
    return this.#model;
  }

  /** The directory this client records into, if it records. */
  get recordDir(): string | undefined {
    return this.#record;
  }

  /** The directory this client replays from, if it replays. */
  get replayDir(): string | undefined {
    return this.#replay;
  }

  /**
   * Ask typed questions about `state` (a string, or any JSON).
   *
   * When recording, the response body is written under its {@link cassetteKey}; when replaying,
   * it is read from there instead and nothing is sent.
   */
  async systemOne(
    state: Json,
    questions: Questions,
    options: CallOptions = {},
  ): Promise<SystemOneResponse> {
    validateQuestions(questions);
    const extra = options.extraBody ?? {};
    const body: JsonObject = {};
    if (!("state" in extra)) body["state"] = state;
    if (!("model" in extra)) body["model"] = options.model ?? this.#model;
    if (!("questions" in extra)) body["questions"] = questionsToJson(questions);
    Object.assign(body, extra);

    if (this.#replay !== undefined) {
      const key = await cassetteKey(body);
      const text = await readCassette(this.#replay, key);
      const meta: ResponseMeta = { status: 200, headers: {}, attempts: 0 };
      return this.#decodeSystemOne(text, meta, `replay ${this.#replay}`);
    }

    const { text, meta, endpoint } = await this.#execute("POST", SYSTEM_ONE_PATH, body, options);
    const response = this.#decodeSystemOne(text, meta, endpoint);
    if (this.#record !== undefined) {
      // The same bytes `jev eval --cache` keeps, so either one can read the other's directory.
      await writeCassette(this.#record, await cassetteKey(body), `${pretty(response.raw)}\n`);
    }
    return response;
  }

  /**
   * Ask a {@link Rubric}'s questions about `state` and read the answers back typed by it:
   * `answers.department.choice` is one of the department's labels, and a misspelled name does not
   * compile. The answers are checked against the rubric too, so an answer that is missing, of the
   * wrong type, or a label the choice does not have is a {@link ResponseValidationError}.
   */
  async ask<R extends RubricQuestions>(
    rubric: Rubric<R>,
    state: Json,
    options: CallOptions = {},
  ): Promise<RubricResponse<R>> {
    const response = await this.systemOne(state, rubric.questions, options);
    return { answers: rubric.decode(response), response };
  }

  #decodeSystemOne(text: string, meta: ResponseMeta, endpoint: string): SystemOneResponse {
    try {
      const decoded = decodeSystemOne(text);
      return makeSystemOneResponse(
        decoded.model,
        decoded.usage,
        decoded.answers,
        decoded.raw,
        meta,
      );
    } catch (e) {
      throw this.#validationError(e, text, meta, endpoint);
    }
  }

  /** The Models resource. */
  models(): { list(options?: CallOptions): Promise<ListModelsResponse> } {
    return {
      list: async (options: CallOptions = {}): Promise<ListModelsResponse> => {
        if (this.#replay !== undefined) {
          throw new ConfigError(
            "models().list() is not recorded, and a replaying client never sends a request.",
          );
        }
        const { text, meta, endpoint } = await this.#execute(
          "GET",
          MODELS_PATH,
          undefined,
          options,
        );
        try {
          const { models, raw } = decodeModels(text);
          return { models, raw, meta };
        } catch (e) {
          throw this.#validationError(e, text, meta, endpoint);
        }
      },
    };
  }

  #validationError(e: unknown, text: string, meta: ResponseMeta, endpoint: string): unknown {
    if (!(e instanceof DecodeFailure)) return e;
    return new ResponseValidationError(
      meta.status,
      e.path,
      e.detail,
      lenientBody(text),
      meta.headers,
      endpoint,
    );
  }

  async #execute(
    method: "GET" | "POST",
    path: string,
    body: JsonObject | undefined,
    options: CallOptions,
  ): Promise<{ text: string; meta: ResponseMeta; endpoint: string }> {
    const retry = options.retry ? { ...this.#retry, ...options.retry } : this.#retry;
    validateRetryPolicy(retry);
    const timeoutMs = checkTimeout(options.timeoutMs ?? this.#timeoutMs);
    const url = `${this.#baseUrl}${path}`;
    const endpoint = `${method} ${redactUrl(url)}`;

    const headers: Record<string, string> = { ...this.#headers };
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers[key.toLowerCase()] = value;
    }
    delete headers[RETRY_COUNT_HEADER];
    Object.assign(headers, this.#protected);
    let payload: string | undefined;
    if (body !== undefined) {
      try {
        payload = JSON.stringify(body);
      } catch (e) {
        throw new TypeSafeError(
          `The request body could not be encoded as JSON: ${e instanceof Error ? e.message : e}`,
        );
      }
      headers["content-type"] = "application/json";
    }

    const started = Date.now();
    let attempts = 0;
    for (;;) {
      const attemptHeaders = { ...headers };
      if (attempts > 0) attemptHeaders[RETRY_COUNT_HEADER] = String(attempts);
      attempts += 1;
      try {
        const {
          text,
          status,
          headers: responseHeaders,
        } = await this.#attempt(
          method,
          url,
          endpoint,
          attemptHeaders,
          payload,
          timeoutMs,
          options.signal,
        );
        return { text, meta: { status, headers: responseHeaders, attempts }, endpoint };
      } catch (error) {
        if (!(error instanceof TypeSafeError) || !isRetryable(retry, error)) throw error;
        const delay = retryDelayMs(retry, attempts, error);
        if (shouldStop(retry, attempts, Date.now() - started, delay)) throw error;
        if (delay > 0) await sleep(delay);
      }
    }
  }

  async #attempt(
    method: string,
    url: string,
    endpoint: string,
    headers: Record<string, string>,
    body: string | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ text: string; status: number; headers: Headers }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      const responseHeaders = headerRecord(response.headers);
      const text = await response.text();
      if (!response.ok) {
        throw new ApiError(response.status, lenientBody(text), responseHeaders, endpoint);
      }
      return { text, status: response.status, headers: responseHeaders };
    } catch (e) {
      if (e instanceof TypeSafeError) throw e;
      if (timedOut) throw new TimeoutError(timeoutMs);
      if (signal?.aborted) throw e;
      throw new ConnectionError(withoutSecrets(e, url, headers["authorization"]));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
