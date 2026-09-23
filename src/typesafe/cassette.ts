/**
 * Record and replay: a directory of response bodies, one file per request.
 *
 * A file is named by {@link cassetteKey} — the SHA-256 of the compact JSON request body — and
 * holds the response body, pretty-printed. That is the same key and the same file `jev eval
 * --cache` writes, so a cassette directory and an eval cache are one thing under two names.
 *
 * Nothing here imports a `node:` module at load time. The hash comes from Web Crypto, and the
 * file system is reached with a dynamic `import()` only when a client actually records or
 * replays, so the module stays in `jev-repl/core` and the browser build never loads `node:fs`.
 */

import type { JsonObject } from "../json.js";
import { compact } from "../json.js";
import { TypeSafeError } from "./errors.js";

/** A request with no recording in the replay directory. Nothing was sent. */
export class ReplayMissError extends TypeSafeError {
  /** The cassette key the request hashed to. */
  readonly key: string;
  /** The file that was expected to hold its response. */
  readonly path: string;

  constructor(key: string, path: string) {
    super(
      `Replay miss: no recording for this request at ${path} (key ${key}). A replaying client ` +
        "never sends a request; record it first with TYPESAFE_RECORD, or check that the state, " +
        "model and questions match the recorded run exactly.",
    );
    this.key = key;
    this.path = path;
  }
}

/**
 * The cassette key of a request body: SHA-256 of its compact JSON, in lowercase hex.
 *
 * For a plain `systemOne` call the body is `{ state, model, questions }` in that order, which is
 * exactly what `jev eval --cache` hashes. Key order matters — it is part of the JSON.
 */
export async function cassetteKey(body: JsonObject): Promise<string> {
  const bytes = new TextEncoder().encode(compact(body));
  const subtle = globalThis.crypto?.subtle ?? (await import("node:crypto")).webcrypto.subtle;
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Where the recording for `key` lives under `dir`. */
export async function cassettePath(dir: string, key: string): Promise<string> {
  const { join } = await import("node:path");
  return join(dir, `${key}.json`);
}

/** The recorded body for `key`, or a {@link ReplayMissError} when there is none. */
export async function readCassette(dir: string, key: string): Promise<string> {
  const path = await cassettePath(dir, key);
  const { readFile } = await import("node:fs/promises");
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new ReplayMissError(key, path);
    throw new TypeSafeError(
      `Could not read the recording at ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
}

/** Write `text` as the recording for `key`, creating `dir` as needed. */
export async function writeCassette(dir: string, key: string, text: string): Promise<void> {
  const path = await cassettePath(dir, key);
  const { mkdir, writeFile } = await import("node:fs/promises");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path, text);
  } catch (e) {
    throw new TypeSafeError(
      `Could not record the response to ${path}: ${e instanceof Error ? e.message : e}`,
    );
  }
}
