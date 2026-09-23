/** The client: what goes on the wire, what comes back, and what happens when it goes wrong. */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Json } from "../src/json.js";
import { compact, pretty } from "../src/json.js";
import {
  ApiError,
  Client,
  ConfigError,
  ConnectionError,
  InvalidRequestError,
  ReplayMissError,
  ResponseValidationError,
  TimeoutError,
  backoffMs,
  cassetteKey,
  choice,
  defaultRetryPolicy,
  extractMessage,
  isRetryable,
  noul,
  parseRetryAfter,
  questionsToJson,
  raw,
  score,
  shouldStop,
  validateQuestions,
} from "../src/index.js";

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that replays the given responses and records what it was asked. */
function stubFetch(responses: Array<Response | (() => Response | Promise<Response>)>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next === undefined) throw new Error("no response queued");
    return typeof next === "function" ? next() : next;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function json(body: Json, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

const ANSWERS = {
  model: "jev-latest",
  usage: { input_tokens: 312, output_tokens: 48 },
  answers: {
    department: {
      type: "choice",
      choice: "technical",
      probabilities: { billing: 0.159, technical: 0.84, sales: 0.001 },
      confidence: 0.596,
    },
    frustration: {
      type: "score",
      score: 1.6,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
      confidence: 0.78,
    },
    is_urgent: { type: "noul", noul: 0.999 },
    future: { type: "span", start: 3 },
  },
} satisfies Json;

function client(fetchImpl: typeof globalThis.fetch, options = {}): Client {
  return new Client({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetch: fetchImpl,
    ...options,
  });
}

describe("configuration", () => {
  it("needs an API key", () => {
    const saved = process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"];
    try {
      expect(() => Client.fromEnv()).toThrow(ConfigError);
    } finally {
      if (saved !== undefined) process.env["TYPESAFE_API_KEY"] = saved;
    }
  });

  it("rejects a base URL that is not http(s)", () => {
    expect(() => new Client({ apiKey: "k", baseUrl: "ftp://x/y" })).toThrow(ConfigError);
    expect(() => new Client({ apiKey: "k", baseUrl: "not a url" })).toThrow(ConfigError);
  });

  it("trims the API key and rejects one the API cannot accept", () => {
    expect(() => new Client({ apiKey: "  sk-test\n" })).not.toThrow();
    for (const bad of ["", "   ", "sk test", "sk\ttest", "sk-\x7f", "sk-é"]) {
      expect(() => new Client({ apiKey: bad }), JSON.stringify(bad)).toThrow(
        bad.trim() === "" ? /No API key/ : /printable ASCII/,
      );
    }
  });

  it("rejects a non-positive timeout", () => {
    expect(() => new Client({ apiKey: "k", timeoutMs: 0 })).toThrow(ConfigError);
  });

  it("goes through an AI gateway: a path of its own, and a key of its own", async () => {
    const { fetch, calls } = stubFetch([json(ANSWERS)]);
    const c = client(fetch, {
      baseUrl: "https://gateway.example.test/v1/acct/gw/typesafe/",
      headers: { "cf-aig-authorization": "Bearer gw-key" },
    });
    await c.systemOne("x", { a: noul("y") });
    expect(calls[0]?.url).toBe("https://gateway.example.test/v1/acct/gw/typesafe/v1/systemone");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["cf-aig-authorization"]).toBe("Bearer gw-key");
    expect(headers["authorization"]).toBe("Bearer sk-test");
  });

  it("defaults the model and trims the base URL", async () => {
    const { fetch, calls } = stubFetch([json(ANSWERS)]);
    const c = new Client({ apiKey: "k", baseUrl: "https://api.example.test/", fetch });
    expect(c.defaultModel).toBe("jev-latest");
    await c.systemOne("x", { a: noul("y") });
    expect(calls[0]?.url).toBe("https://api.example.test/v1/systemone");
  });
});

describe("requests", () => {
  it("sends the state, model and questions in order", async () => {
    const { fetch, calls } = stubFetch([json(ANSWERS)]);
    await client(fetch).systemOne(
      "The payout failed.",
      {
        department: choice("Which team", { billing: "Payments", technical: null }),
        frustration: score("How frustrated", ["Calm", "Angry"]),
        is_urgent: noul("Urgent?", { yes: "A deadline" }),
      },
      { model: "jev-2" },
    );
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, Json>;
    expect(Object.keys(sent)).toEqual(["state", "model", "questions"]);
    expect(sent["state"]).toBe("The payout failed.");
    expect(sent["model"]).toBe("jev-2");
    expect(sent["questions"]).toEqual({
      department: {
        type: "choice",
        instructions: "Which team",
        criteria: { billing: "Payments", technical: null },
      },
      frustration: { type: "score", instructions: "How frustrated", criteria: ["Calm", "Angry"] },
      is_urgent: { type: "noul", instructions: "Urgent?", criteria: { true: "A deadline" } },
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-typesafe-sdk"]).toMatch(/^jev-repl-ts\//);
  });

  it("serializes questions like the API reference", () => {
    expect(
      questionsToJson([
        ["bare", noul()],
        ["r", raw({ type: "mystery", k: 1 })],
      ]),
    ).toEqual({ bare: { type: "noul" }, r: { type: "mystery", k: 1 } });
  });

  it("lets extraBody replace a standard field", async () => {
    const { fetch, calls } = stubFetch([json(ANSWERS)]);
    await client(fetch).systemOne(
      "x",
      { a: noul("y") },
      { extraBody: { model: "pinned", extra: 1 } },
    );
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, Json>;
    expect(sent["model"]).toBe("pinned");
    expect(sent["extra"]).toBe(1);
  });

  it("rejects an invalid request before sending it", async () => {
    const { fetch, calls } = stubFetch([json(ANSWERS)]);
    await expect(client(fetch).systemOne("x", {})).rejects.toBeInstanceOf(InvalidRequestError);
    expect(() => validateQuestions({ s: score("x", []) })).toThrow(InvalidRequestError);
    expect(() => validateQuestions({ c: choice("x", {}) })).toThrow(InvalidRequestError);
    expect(() => validateQuestions({ r: raw({ instructions: "no type" }) })).toThrow(
      InvalidRequestError,
    );
    expect(() => validateQuestions({ r: raw({ type: "choice", criteria: {} }) })).toThrow(
      InvalidRequestError,
    );
    expect(() => validateQuestions({ r: raw({ type: "noul", future_field: 1 }) })).not.toThrow();
    expect(calls, "nothing reached the API").toHaveLength(0);
  });
});

describe("responses", () => {
  it("decodes every answer type and skips unknown ones", async () => {
    const { fetch } = stubFetch([
      json(ANSWERS, { headers: { "x-typesafe-request-id": "req_42" } }),
    ]);
    const res = await client(fetch).systemOne("x", { a: noul("y") });
    expect(res.model).toBe("jev-latest");
    expect(res.usage.inputTokens).toBe(312);
    expect(res.answers.size).toBe(3);
    expect(res.meta.attempts).toBe(1);
    expect(res.requestId).toBe("req_42");
    expect(res.noul("is_urgent")?.noul).toBe(0.999);
    expect(res.choice("department")?.choice).toBe("technical");
    expect(res.score("frustration")?.legend.get(2)).toBe("Very angry");
    // The unknown answer type is still in the raw body.
    expect((res.raw as Record<string, Record<string, Json>>)["answers"]?.["future"]).toEqual({
      type: "span",
      start: 3,
    });
    // A lookup of the wrong type is undefined, not a wrong answer.
    expect(res.noul("department")).toBeUndefined();
  });

  it("keeps the server's order of probabilities", async () => {
    const { fetch } = stubFetch([
      json({
        model: "m",
        answers: {
          c: {
            type: "choice",
            choice: "z",
            probabilities: { z: 0.5, a: 0.3, m: 0.2 },
            confidence: 0.1,
          },
        },
      }),
    ]);
    const res = await client(fetch).systemOne("x", { a: noul("y") });
    expect(Object.keys(res.choice("c")?.probabilities ?? {})).toEqual(["z", "a", "m"]);
  });

  it("reports the path of a bad field", async () => {
    const broken = structuredClone(ANSWERS) as unknown as Record<string, Json>;
    const answers = broken["answers"] as Record<string, Record<string, Json>>;
    delete answers["department"]?.["confidence"];
    const { fetch } = stubFetch([json(broken)]);
    await expect(client(fetch).systemOne("x", { a: noul("y") })).rejects.toMatchObject({
      name: "ResponseValidationError",
      fieldPath: "answers.department.confidence",
    });
  });

  it("rejects a body that is not JSON at all", async () => {
    const { fetch } = stubFetch([new Response("<html>", { status: 200 })]);
    const error = await client(fetch)
      .systemOne("x", { a: noul("y") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResponseValidationError);
  });

  it("lists models", async () => {
    const { fetch, calls } = stubFetch([
      json({ models: [{ name: "jev-2", description: "d", release_date: "2025-11-12" }] }),
    ]);
    const res = await client(fetch).models().list();
    expect(res.models[0]?.name).toBe("jev-2");
    expect(calls[0]?.url).toContain("/v1/models");
    expect(calls[0]?.init.method).toBe("GET");
  });
});

describe("errors and retries", () => {
  it("raises an ApiError with the message from the body", async () => {
    const { fetch } = stubFetch([
      json(
        { detail: [{ loc: ["body", "questions", "x"], msg: "Field required" }] },
        { status: 422 },
      ),
    ]);
    const error = (await client(fetch)
      .systemOne("x", { a: noul("y") })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.httpStatus).toBe(422);
    expect(error.kind).toBe("UnprocessableEntity");
    expect(error.message).toContain("questions.x: Field required");
  });

  it("retries a 500 and then succeeds", async () => {
    const { fetch, calls } = stubFetch([
      () => json({ error: "boom" }, { status: 500 }),
      () => json({ error: "boom" }, { status: 500 }),
      () => json(ANSWERS),
    ]);
    const res = await client(fetch, {
      retry: { backoffInitialMs: 0, backoffMaxMs: 0 },
    }).systemOne("x", { a: noul("y") });
    expect(calls).toHaveLength(3);
    expect(res.meta.attempts).toBe(3);
    expect(calls[1]?.init.headers).toMatchObject({ "x-typesafe-retry-count": "1" });
  });

  it("gives up after the configured retries", async () => {
    const { fetch, calls } = stubFetch([() => json({ error: "boom" }, { status: 503 })]);
    await expect(
      client(fetch, { retry: { maxRetries: 1, backoffInitialMs: 0 } }).systemOne("x", {
        a: noul("y"),
      }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 422", async () => {
    const { fetch, calls } = stubFetch([() => json({ error: "nope" }, { status: 422 })]);
    await expect(client(fetch).systemOne("x", { a: noul("y") })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toHaveLength(1);
  });

  it("turns a transport failure into a ConnectionError", async () => {
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      client(fetch, { retry: { maxRetries: 0 } }).systemOne("x", { a: noul("y") }),
    ).rejects.toBeInstanceOf(ConnectionError);
  });

  it("keeps URL credentials and the key out of a ConnectionError", async () => {
    const error = await new Client({
      apiKey: "sk-secret",
      baseUrl: "http://user:hunter2@127.0.0.1:1",
      retry: { maxRetries: 0 },
      fetch: (async (url: string) => {
        throw new TypeError(`bad ${url} with sk-secret`, { cause: new Error(`inner ${url}`) });
      }) as unknown as typeof globalThis.fetch,
    })
      .systemOne("x", { a: noul("y") })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectionError);
    const text = `${String(error)} ${String((error as Error).cause)} ${String(
      ((error as Error).cause as Error).cause,
    )}`;
    expect(text).toContain("user:***@127.0.0.1");
    expect(text).not.toMatch(/hunter2|sk-secret/);
  });

  it("names a bad model entry by its index", async () => {
    const { fetch } = stubFetch([
      json({ models: [{ name: "a", description: "", release_date: "" }, {}] }),
    ]);
    const error = await client(fetch)
      .models()
      .list()
      .catch((e: unknown) => e);
    expect((error as ResponseValidationError).fieldPath).toBe("models[1].name");
  });

  it("times an attempt out", async () => {
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof globalThis.fetch;
    await expect(
      client(fetch, { timeoutMs: 5, retry: { maxRetries: 0 } }).systemOne("x", { a: noul("y") }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("computes backoff the way the other SDKs do", () => {
    const delay = (attempt: number): number => backoffMs(attempt, 500, 5000, 0.25, 0);
    expect(delay(1)).toBe(500);
    expect(delay(2)).toBe(1000);
    expect(delay(4)).toBe(4000);
    expect(delay(5)).toBe(5000);
    expect(delay(40)).toBe(5000);
    // Full jitter subtracts up to 25%.
    expect(backoffMs(1, 500, 5000, 0.25, 1)).toBe(375);
    expect(backoffMs(1, 0, 5000, 0.25, 0.5)).toBe(0);
  });

  it("stops on the retry count or the time budget", () => {
    const policy = defaultRetryPolicy();
    expect(shouldStop(policy, 1, 0, 1000)).toBe(false);
    expect(shouldStop(policy, 2, 0, 1000)).toBe(false);
    expect(shouldStop(policy, 3, 0, 1000)).toBe(true);
    expect(shouldStop(policy, 1, 29_000, 1000)).toBe(true);
    expect(shouldStop({ ...policy, budgetMs: null }, 1, 99_000, 1000)).toBe(false);
  });

  it("retries the statuses the other SDKs retry, 529 included", () => {
    const policy = defaultRetryPolicy();
    for (const status of [408, 429, 500, 503, 529, 599]) {
      expect(isRetryable(policy, new ApiError(status, null, {}))).toBe(true);
    }
    expect(isRetryable(policy, new ApiError(422, null, {}))).toBe(false);
    expect(isRetryable(policy, new ConnectionError(new Error("x")))).toBe(true);
    expect(isRetryable(policy, new TimeoutError(10))).toBe(true);
    expect(isRetryable({ ...policy, retryTimeouts: false }, new TimeoutError(10))).toBe(false);
  });

  it("honours retry-after in both spellings", () => {
    expect(parseRetryAfter({ "retry-after-ms": "250", "retry-after": "9" })).toBe(250);
    expect(parseRetryAfter({ "retry-after": "2" })).toBe(2000);
    expect(parseRetryAfter({ "retry-after": "-1" })).toBeUndefined();
    expect(parseRetryAfter({ "retry-after": " Wed, 21 Oct 2015 07:28:00 GMT " })).toBe(0);
    expect(parseRetryAfter({})).toBeUndefined();
  });

  it("extracts the message the API actually sent", () => {
    expect(extractMessage({ error: "e", message: "m" })).toBe("e");
    expect(extractMessage({ error: { message: "em" } })).toBe("em");
    expect(extractMessage({ message: "m", detail: "d" })).toBe("m");
    expect(extractMessage({ detail: { message: "dm" } })).toBe("dm");
    expect(extractMessage({ other: 1 })).toBeUndefined();
    expect(extractMessage("")).toBeUndefined();
    expect(
      extractMessage({
        detail: [
          { loc: ["body", "questions", "x", "criteria"], msg: "Field required" },
          { loc: ["body", "model"], msg: "Bad model" },
        ],
      }),
    ).toBe("questions.x.criteria: Field required; model: Bad model");
  });

  it("truncates a very long error body", () => {
    const error = new ApiError(500, { x: "y".repeat(500) }, {});
    expect([...error.detail]).toHaveLength(201);
    expect(error.detail.endsWith("…")).toBe(true);
  });

  it("says so when there is no body at all", () => {
    const error = new ApiError(503, undefined, {}, "GET http://x/v1/models");
    expect(error.message).toBe("GET http://x/v1/models: 503 status code (no body)");
    expect(error.kind).toBe("InternalServer");
  });
});

/** A scratch directory for one test, removed afterwards whatever happens. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "jev-cassette-"));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `body` with these environment variables set (or unset, for `undefined`), then restore. */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  put(vars);
  try {
    return body();
  } finally {
    put(saved);
  }
}

const URGENT = { is_urgent: noul("The message conveys urgency") };

describe("record and replay", () => {
  it("pins the cassette key the other SDKs share", async () => {
    // The Rust SDK hashes the same fixture to the same digest; change one, change both.
    const body = {
      state: "The payout failed again.",
      model: "jev-latest",
      questions: questionsToJson(URGENT),
    };
    expect(compact(body)).toBe(
      '{"state":"The payout failed again.","model":"jev-latest","questions":{"is_urgent":{"type":"noul","instructions":"The message conveys urgency"}}}',
    );
    const key = await cassetteKey(body);
    expect(key).toBe("4bb6a561cd7ce28500dc6aa8fc821771e45e4f811f1195c2441263651a7dca55");
    // The same key `jev eval --cache` has always used: SHA-256 of the compact body.
    expect(key).toBe(createHash("sha256").update(compact(body)).digest("hex"));
  });

  it("records each successful response under its key", async () => {
    await inTempDir(async (root) => {
      const dir = join(root, "cassettes", "nested");
      const { fetch } = stubFetch([json(ANSWERS)]);
      await client(fetch, { record: dir }).systemOne("The payout failed again.", URGENT);
      const key = await cassetteKey({
        state: "The payout failed again.",
        model: "jev-latest",
        questions: questionsToJson(URGENT),
      });
      expect(readFileSync(join(dir, `${key}.json`), "utf8")).toBe(`${pretty(ANSWERS)}\n`);
    });
  });

  it("does not record a failed call", async () => {
    await inTempDir(async (dir) => {
      const { fetch } = stubFetch([json({ error: "nope" }, { status: 400 })]);
      await expect(
        client(fetch, { record: dir }).systemOne("The payout failed again.", URGENT),
      ).rejects.toThrow(ApiError);
      const key = await cassetteKey({
        state: "The payout failed again.",
        model: "jev-latest",
        questions: questionsToJson(URGENT),
      });
      expect(existsSync(join(dir, `${key}.json`))).toBe(false);
    });
  });

  it("replays what was recorded, with no network and no API key", async () => {
    await inTempDir(async (dir) => {
      const recording = stubFetch([json(ANSWERS)]);
      const live = await client(recording.fetch, { record: dir }).systemOne(
        "The payout failed again.",
        URGENT,
      );

      const replaying = stubFetch([]);
      const res = await withEnv({ TYPESAFE_API_KEY: undefined }, () =>
        new Client({ replay: dir, fetch: replaying.fetch }).systemOne(
          "The payout failed again.",
          URGENT,
        ),
      );
      expect(replaying.calls).toHaveLength(0);
      expect(res.raw).toEqual(live.raw);
      expect(res.noul("is_urgent")?.noul).toBe(0.999);
      expect(res.meta.attempts).toBe(0);
    });
  });

  it("throws a replay miss rather than sending anything", async () => {
    await inTempDir(async (dir) => {
      const { fetch, calls } = stubFetch([json(ANSWERS)]);
      const replaying = client(fetch, { replay: dir });
      const error = await replaying
        .systemOne("Something never recorded.", URGENT)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ReplayMissError);
      const miss = error as ReplayMissError;
      expect(miss.key).toMatch(/^[0-9a-f]{64}$/);
      expect(miss.path).toBe(join(dir, `${miss.key}.json`));
      expect(miss.message).toContain(miss.path);
      expect(calls).toHaveLength(0);
      await expect(replaying.models().list()).rejects.toThrow(ConfigError);
      expect(calls).toHaveLength(0);
    });
  });

  it("keys on the whole body, so a different model misses", async () => {
    await inTempDir(async (dir) => {
      const { fetch } = stubFetch([json(ANSWERS)]);
      await client(fetch, { record: dir }).systemOne("The payout failed again.", URGENT);
      const replaying = client(stubFetch([]).fetch, { replay: dir });
      await expect(
        replaying.systemOne("The payout failed again.", URGENT, { model: "jev-other" }),
      ).rejects.toThrow(ReplayMissError);
    });
  });

  it("reports a recording that does not decode", async () => {
    await inTempDir(async (dir) => {
      const key = await cassetteKey({
        state: "The payout failed again.",
        model: "jev-latest",
        questions: questionsToJson(URGENT),
      });
      writeFileSync(join(dir, `${key}.json`), '{"answers": 3}');
      await expect(
        client(stubFetch([]).fetch, { replay: dir }).systemOne("The payout failed again.", URGENT),
      ).rejects.toThrow(ResponseValidationError);
    });
  });

  it("reads the directories from the environment", () => {
    const c = withEnv({ TYPESAFE_RECORD: "rec", TYPESAFE_REPLAY: undefined }, () =>
      client(stubFetch([]).fetch),
    );
    expect(c.recordDir).toBe("rec");
    expect(c.replayDir).toBeUndefined();
    const r = withEnv({ TYPESAFE_RECORD: undefined, TYPESAFE_REPLAY: "tape" }, () =>
      client(stubFetch([]).fetch),
    );
    expect(r.replayDir).toBe("tape");
  });

  it("lets an explicit option win over the environment", () => {
    const c = withEnv({ TYPESAFE_RECORD: "rec", TYPESAFE_REPLAY: undefined }, () =>
      client(stubFetch([]).fetch, { replay: "tape" }),
    );
    expect(c.replayDir).toBe("tape");
    expect(c.recordDir).toBeUndefined();
  });

  it("refuses to record and replay at once", () => {
    expect(() => client(stubFetch([]).fetch, { record: "a", replay: "b" })).toThrow(ConfigError);
    expect(() =>
      withEnv({ TYPESAFE_RECORD: "a", TYPESAFE_REPLAY: "b" }, () => client(stubFetch([]).fetch)),
    ).toThrow(/TYPESAFE_RECORD and TYPESAFE_REPLAY/);
  });

  it("still needs an API key to record", () => {
    expect(() =>
      withEnv({ TYPESAFE_API_KEY: undefined }, () => new Client({ record: "rec" })),
    ).toThrow(ConfigError);
  });
});
