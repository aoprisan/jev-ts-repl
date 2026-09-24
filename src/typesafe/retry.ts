/**
 * Retry configuration. Semantics match the Rust and Python SDKs: exponential backoff with
 * subtractive jitter, `Retry-After`/`retry-after-ms` support, a max retry count, and a total time
 * budget that stops *before* a sleep that would exceed it.
 */

import { ApiError, ConfigError, ConnectionError, TimeoutError, TypeSafeError } from "./errors.js";

/** How failed requests are retried. All durations are milliseconds. */
export interface RetryPolicy {
  /** Retries after the first attempt; `0` disables retries. Default `2`. */
  maxRetries: number;
  /** First backoff delay, doubled per attempt up to `backoffMaxMs`; zero disables backoff. Default 500. */
  backoffInitialMs: number;
  /** Maximum backoff delay; zero disables backoff. Default 5000. */
  backoffMaxMs: number;
  /** Fraction of each delay randomly subtracted, in `[0, 1]`. Default `0.25`. */
  backoffJitter: number;
  /** Statuses that are retried. Default 408, 429 and 500–599 (which includes TypeSafe's 529). */
  httpStatuses: ReadonlySet<number>;
  /** Honor `retry-after-ms` / `Retry-After`. Default `true`. */
  respectRetryAfter: boolean;
  /** Retry {@link ConnectionError}. Default `true`. */
  retryConnectionErrors: boolean;
  /** Retry {@link TimeoutError}. Default `true`. */
  retryTimeouts: boolean;
  /** Extra predicate; returning `true` also triggers a retry. */
  predicate?: (error: TypeSafeError) => boolean;
  /** Total budget per SDK call including attempts and delays; `null` = unlimited. Default 30000. */
  budgetMs: number | null;
}

/** The default policy: two retries, exponential backoff, a 30 s budget. */
export function defaultRetryPolicy(): RetryPolicy {
  const statuses = new Set<number>([408, 429]);
  for (let s = 500; s < 600; s += 1) statuses.add(s);
  return {
    maxRetries: 2,
    backoffInitialMs: 500,
    backoffMaxMs: 5_000,
    backoffJitter: 0.25,
    httpStatuses: statuses,
    respectRetryAfter: true,
    retryConnectionErrors: true,
    retryTimeouts: true,
    budgetMs: 30_000,
  };
}

/** A policy that never retries. */
export function noRetries(): RetryPolicy {
  return { ...defaultRetryPolicy(), maxRetries: 0 };
}

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!(policy.backoffJitter >= 0 && policy.backoffJitter <= 1)) {
    throw new ConfigError("backoff_jitter must be between zero and one.");
  }
  if (policy.budgetMs !== null && policy.budgetMs <= 0) {
    throw new ConfigError("retry budget must be a positive duration.");
  }
}

export function isRetryable(policy: RetryPolicy, error: TypeSafeError): boolean {
  let builtin = false;
  if (error instanceof TimeoutError) builtin = policy.retryTimeouts;
  else if (error instanceof ConnectionError) builtin = policy.retryConnectionErrors;
  else if (error instanceof ApiError) builtin = policy.httpStatuses.has(error.httpStatus);
  return builtin || (policy.predicate?.(error) ?? false);
}

/** Delay before the next attempt; `attempt` is the 1-based number of the attempt that just failed. */
export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  error: TypeSafeError,
  random: () => number = Math.random,
): number {
  if (policy.respectRetryAfter && error instanceof ApiError) {
    const wait = error.retryAfterMs();
    if (wait !== undefined) return wait;
  }
  return backoffMs(
    attempt,
    policy.backoffInitialMs,
    policy.backoffMaxMs,
    policy.backoffJitter,
    random(),
  );
}

/** Whether to stop instead of sleeping `upcoming` after `attempts` attempts and `elapsed` time. */
export function shouldStop(
  policy: RetryPolicy,
  attempts: number,
  elapsedMs: number,
  upcomingMs: number,
): boolean {
  if (attempts > policy.maxRetries) return true;
  return policy.budgetMs !== null && elapsedMs + upcomingMs >= policy.budgetMs;
}

export function backoffMs(
  attempt: number,
  initialMs: number,
  maxMs: number,
  jitter: number,
  r: number,
): number {
  if (initialMs === 0 || maxMs === 0) return 0;
  const initial = initialMs / 1000;
  const max = maxMs / 1000;
  const exponent = Math.max(0, attempt - 1);
  const exponential =
    exponent >= Math.log2(max) - Math.log2(initial) ? max : initial * Math.pow(2, exponent);
  const delay = exponential * (1 - r * jitter);
  const rounded = Math.round(delay * 1000) / 1000;
  return Math.min(exponential, rounded) * 1000;
}

/**
 * Waits out a retry backoff. The timer stays referenced: during a backoff it is the only thing
 * keeping a one-shot command alive, and an unreferenced one lets Node exit 0 mid-call. An abort
 * ends the wait at once, with the signal's reason, as it would end the request.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
