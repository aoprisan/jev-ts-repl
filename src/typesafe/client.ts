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
  abortError,
  ApiError,
  ConfigError,
  ConnectionError,
  InvalidRequestError,
  lenientBody,
  type ResponseHeaders,
  ResponseValidationError,
  TimeoutError,
  TypeSafeError,
} from "./errors.js";
import type { Questions } from "./questions.js";
import { questionsToJson, validateQuestions } from "./questions.js";
import type {
  AnswerNamesOf,
  ListModelsResponse,
  ResponseMeta,
  SystemOneResponse,
} from "./responses.js";
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

/**
 * How a {@link Client} is configured. `new Client(options)` uses these and nothing else;
 * {@link Client.fromEnv} fills the unset ones from environment variables, named in parentheses.
 */
export interface ClientOptions {
  /** API key (`TYPESAFE_API_KEY`). Required unless the client replays. */
  apiKey?: string;
  /** API root (`TYPESAFE_BASE_URL`), default `https://api.typesafe.ai`. */
  baseUrl?: string;
  /** Default model (`TYPESAFE_DEFAULT_MODEL`), default `jev-latest`. */
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
   * Write every successful `systemOne` response body to `<dir>/<key>.json`
   * (`TYPESAFE_RECORD`). Node only.
   */
  record?: string;
  /**
   * Answer `systemOne` from `<dir>/<key>.json` and never touch the network
   * (`TYPESAFE_REPLAY`). No API key is needed; a request with no recording throws
   * {@link ReplayMissError}. Node only.
   */
  replay?: string;
}

/** How {@link Client.fromEnv} is configured: explicit settings win over environment variables. */
export interface FromEnvOptions extends ClientOptions {
  /**
   * Read the environment variables from this record instead of Node's environment, e.g. a
   * tenant's settings on a multi-tenant server. Default: Node's environment, nothing in a browser.
   */
  env?: Record<string, string | undefined>;
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
  /**
   * Abort this call from outside. An abort throws {@link UserAbortError} with the signal's reason
   * as its `cause`, or {@link TimeoutError} when the signal timed out (`AbortSignal.timeout(ms)`).
   */
  signal?: AbortSignal;
}

/** The Models resource: `client.models.list()`. */
export interface ModelsResource {
  /** The models available to the account. */
  list(options?: CallOptions): Promise<ListModelsResponse>;
}

/**
 * A variable from `source`, else Node's environment, or nothing at all. The client runs in a
 * browser too, where `process` does not exist and the key is passed in explicitly.
 */
function env(name: string, source?: Record<string, string | undefined>): string | undefined {
  source ??= typeof process === "undefined" ? undefined : process.env;
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

/**
 * `state` as the JSON it will be sent as. Anything `JSON.stringify` refuses or drops (a cycle, a
 * BigInt, a function, `undefined`) is an {@link InvalidRequestError} before anything is sent.
 */
function encodeState(state: unknown): Json {
  let text: string | undefined;
  try {
    text = JSON.stringify(state);
  } catch (e) {
    throw new InvalidRequestError(
      `state could not be encoded as JSON: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (text === undefined) {
    throw new InvalidRequestError(`state could not be encoded as JSON: got ${typeof state}.`);
  }
  return JSON.parse(text) as Json;
}

function checkBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new ConfigError(
      `baseUrl ${JSON.stringify(url)} is not a valid URL: ${e instanceof Error ? e.message : e}.`,
    );
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    throw new ConfigError(
      `baseUrl must be an http(s) URL with a host, got ${JSON.stringify(url)}.`,
    );
  }
}

function checkTimeout(ms: number): number {
  if (!(ms > 0) || !Number.isFinite(ms)) {
    throw new ConfigError("timeoutMs must be a positive duration.");
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

function headerRecord(headers: globalThis.Headers): ResponseHeaders {
  const out: ResponseHeaders = {};
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

  /** The Models resource. */
  readonly models: ModelsResource;

  /**
   * A client configured by `options` alone; nothing is read from the environment (see
   * {@link Client.fromEnv}). Throws {@link ConfigError} for a missing or malformed key, a bad base
   * URL, timeout or retry policy, or both `record` and `replay`.
   */
  constructor(options: ClientOptions = {}) {
    const { record, replay } = options;
    if (record !== undefined && replay !== undefined) {
      throw new ConfigError(
        "record and replay cannot both be set: a client either records or replays.",
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

    const apiKey = options.apiKey?.trim() || undefined;
    if (replay === undefined && apiKey === undefined) {
      throw new ConfigError(
        `No API key was provided. Pass apiKey, or use Client.fromEnv() to read ${API_KEY_ENV}.`,
      );
    }
    if (apiKey !== undefined && !/^[\x21-\x7e]+$/.test(apiKey)) {
      throw new ConfigError(
        "API key must contain only printable ASCII characters without whitespace.",
      );
    }
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    checkBaseUrl(baseUrl);
    const retry = { ...defaultRetryPolicy(), ...options.retry };
    validateRetryPolicy(retry);

    this.#baseUrl = baseUrl;
    this.#model = options.model ?? DEFAULT_MODEL;
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
    this.models = { list: (listOptions) => this.#listModels(listOptions) };
  }

  /**
   * A client configured from the environment: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`,
   * `TYPESAFE_DEFAULT_MODEL`, `TYPESAFE_RECORD` and `TYPESAFE_REPLAY`, read from `options.env`
   * (default: Node's environment). A setting passed in `options` wins over its variable; setting
   * either `record` or `replay` leaves both variables unread.
   */
  static fromEnv(options: FromEnvOptions = {}): Client {
    const { env: source, ...explicit } = options;
    const hand = explicit.record !== undefined || explicit.replay !== undefined;
    const record = hand ? explicit.record : env(RECORD_ENV, source);
    const replay = hand ? explicit.replay : env(REPLAY_ENV, source);
    if (!hand && record !== undefined && replay !== undefined) {
      throw new ConfigError(
        `${RECORD_ENV} and ${REPLAY_ENV} cannot both be set: a client either records or replays.`,
      );
    }
    const apiKey = explicit.apiKey ?? env(API_KEY_ENV, source);
    if (replay === undefined && (apiKey === undefined || apiKey.trim() === "")) {
      throw new ConfigError(
        `No API key was provided. Pass apiKey or set the ${API_KEY_ENV} environment variable.`,
      );
    }
    return new Client({
      ...explicit,
      apiKey,
      baseUrl: explicit.baseUrl ?? env(BASE_URL_ENV, source),
      model: explicit.model ?? env(DEFAULT_MODEL_ENV, source),
      record,
      replay,
    });
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
   * Ask typed questions about `state`: a string, or anything JSON-serialisable (checked when the
   * request is encoded; anything else is an {@link InvalidRequestError}). When the questions'
   * names are known, `res.noul(name)` and its siblings only take the names of that kind.
   *
   * When recording, the response body is written under its {@link cassetteKey}; when replaying,
   * it is read from there instead and nothing is sent.
   */
  async systemOne<const Q extends Questions>(
    state: unknown,
    questions: Q,
    options: CallOptions = {},
  ): Promise<SystemOneResponse<AnswerNamesOf<Q>>> {
    validateQuestions(questions);
    const extra = options.extraBody ?? {};
    const body: JsonObject = {};
    if (!("state" in extra)) body["state"] = encodeState(state);
    if (!("model" in extra)) body["model"] = options.model ?? this.#model;
    if (!("questions" in extra)) body["questions"] = questionsToJson(questions);
    Object.assign(body, extra);

    if (this.#replay !== undefined) {
      if (options.signal?.aborted) throw abortError(options.signal);
      const key = await cassetteKey(body);
      const text = await readCassette(this.#replay, key);
      const meta: ResponseMeta = { status: 200, headers: {}, attempts: 0 };
      return this.#decodeSystemOne<Q>(text, meta, `replay ${this.#replay}`);
    }

    const { text, meta, endpoint } = await this.#execute("POST", SYSTEM_ONE_PATH, body, options);
    const response = this.#decodeSystemOne<Q>(text, meta, endpoint);
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
    state: unknown,
    rubric: Rubric<R>,
    options: CallOptions = {},
  ): Promise<RubricResponse<R>> {
    const response = await this.systemOne(state, rubric.questions, options);
    return { answers: rubric.decode(response), response };
  }

  #decodeSystemOne<Q extends Questions>(
    text: string,
    meta: ResponseMeta,
    endpoint: string,
  ): SystemOneResponse<AnswerNamesOf<Q>> {
    try {
      const decoded = decodeSystemOne(text);
      return makeSystemOneResponse<AnswerNamesOf<Q>>(
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

  async #listModels(options: CallOptions = {}): Promise<ListModelsResponse> {
    if (this.#replay !== undefined) {
      throw new ConfigError(
        "models.list() is not recorded, and a replaying client never sends a request.",
      );
    }
    const { text, meta, endpoint } = await this.#execute("GET", MODELS_PATH, undefined, options);
    try {
      const { models, raw } = decodeModels(text);
      return { models, raw, meta };
    } catch (e) {
      throw this.#validationError(e, text, meta, endpoint);
    }
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
        throw new InvalidRequestError(
          `The request body could not be encoded as JSON: ${e instanceof Error ? e.message : e}`,
        );
      }
      headers["content-type"] = "application/json";
    }

    const started = Date.now();
    let attempts = 0;
    for (;;) {
      if (options.signal?.aborted) throw abortError(options.signal);
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
        if (delay > 0) {
          try {
            await sleep(delay, options.signal);
          } catch (e) {
            if (options.signal?.aborted) throw abortError(options.signal);
            throw e;
          }
        }
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
  ): Promise<{ text: string; status: number; headers: ResponseHeaders }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort();
    // An "abort" event never fires again for a signal that is already aborted.
    if (signal?.aborted) controller.abort();
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
        throw ApiError.from(response.status, lenientBody(text), responseHeaders, endpoint);
      }
      return { text, status: response.status, headers: responseHeaders };
    } catch (e) {
      if (e instanceof TypeSafeError) throw e;
      if (timedOut) throw new TimeoutError(timeoutMs);
      if (signal?.aborted) throw abortError(signal);
      throw new ConnectionError(withoutSecrets(e, url, headers["authorization"]));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
