/**
 * Offline answers, so the shapes can be learned without an API key.
 *
 * Deterministic: the same state and question always produce the same numbers. Plausible, not
 * predictive — nothing here reasons about anything.
 */

import type { Json } from "../json.js";
import { compact, isObject } from "../json.js";
import type { Answer, ModelMetadata } from "../typesafe/responses.js";

/** Simulate an answer to one question. `undefined` for shapes the simulator cannot fake. */
export function answer(state: Json, name: string, question: Json): Answer | undefined {
  if (!isObject(question)) return undefined;
  const kind = question["type"];
  if (typeof kind !== "string") return undefined;
  const stateText = compact(state);
  const instructions =
    question["instructions"] === undefined ? "" : compact(question["instructions"]);
  const seed = `${stateText}\u0001${name}\u0001${instructions}`;

  if (kind === "noul") {
    return { type: "noul", noul: round(0.04 + 0.92 * unit([seed, "noul"])) };
  }
  if (kind === "choice") {
    const criteria = question["criteria"];
    if (!isObject(criteria)) return undefined;
    const labels = Object.keys(criteria);
    const probs = distribution(seed, stateText, labels);
    let choice = "";
    let best = -Infinity;
    for (const [label, p] of probs) {
      if (p > best) {
        best = p;
        choice = label;
      }
    }
    const probabilities: Record<string, number> = {};
    for (const [label, p] of probs) probabilities[label] = p;
    return {
      type: "choice",
      choice,
      probabilities,
      confidence: confidence(probs.map(([, p]) => p)),
    };
  }
  if (kind === "score") {
    const criteria = question["criteria"];
    if (!Array.isArray(criteria)) return undefined;
    const keys = criteria.map((_, i) => String(i));
    const probs = distribution(seed, stateText, keys);
    const score = round(probs.reduce((sum, [, p], i) => sum + i * p, 0));
    const legend = new Map<number, Json>(criteria.map((v, i) => [i, v]));
    const probabilities = new Map<number, number>(probs.map(([k, p]) => [Number(k), p]));
    return {
      type: "score",
      score,
      confidence: confidence(probs.map(([, p]) => p)),
      legend,
      probabilities,
    };
  }
  return undefined;
}

/** What `:models` shows offline. */
export function models(): ModelMetadata[] {
  return [
    {
      name: "jev-latest",
      description: "Alias for the newest jev release",
      release_date: "2026-05-01",
    },
    { name: "jev-2", description: "Previous generation", release_date: "2025-11-12" },
  ];
}

/** Weights per label, nudged up when the label's word shows up in the state, then normalized. */
function distribution(seed: string, state: string, labels: string[]): Array<[string, number]> {
  const lower = state.toLowerCase();
  const raw: Array<[string, number]> = labels.map((label) => {
    const u = unit([seed, label]);
    let w = 0.02 + u * u * u;
    if (label.length > 3 && lower.includes(label.toLowerCase())) w *= 4;
    return [label, w];
  });
  const total = raw.reduce((sum, [, w]) => sum + w, 0);
  if (total <= 0) {
    const even = round(1 / Math.max(1, raw.length));
    return raw.map(([label]) => [label, even]);
  }
  for (const pair of raw) pair[1] = round(pair[1] / total);
  // Rounding leaves a few thousandths on the table; give them to the leader.
  const drift = 1 - raw.reduce((sum, [, w]) => sum + w, 0);
  if (Math.abs(drift) > Number.EPSILON) {
    let top: [string, number] | undefined;
    for (const pair of raw) if (!top || pair[1] > top[1]) top = pair;
    if (top) top[1] = round(top[1] + drift);
  }
  return raw;
}

/** 0 when the distribution is flat, 1 when it is certain — the same direction the API reports. */
function confidence(probs: readonly number[]): number {
  const n = probs.length;
  if (n < 2) return 1;
  const max = probs.reduce((a, b) => Math.max(a, b), 0);
  const floor = 1 / n;
  return round(Math.min(1, Math.max(0, (max - floor) / (1 - floor))));
}

function unit(parts: readonly string[]): number {
  return Number(fnv(parts) % 100_000n) / 100_000;
}

const MASK = (1n << 64n) - 1n;
const PRIME = 0x100000001b3n;

/** FNV-1a over UTF-8 bytes, with a separator between parts — the Rust REPL's seed, exactly. */
function fnv(parts: readonly string[]): bigint {
  let h = 0xcbf29ce484222325n;
  const encoder = new TextEncoder();
  for (const part of parts) {
    for (const b of encoder.encode(part)) {
      h = (h ^ BigInt(b)) & MASK;
      h = (h * PRIME) & MASK;
    }
    h = (h ^ 0xffn) & MASK;
    h = (h * PRIME) & MASK;
  }
  return h;
}

/** Round to three decimals, away from zero at a half — the way Rust's `f64::round` does. */
function round(x: number): number {
  const scaled = x * 1000;
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return rounded / 1000;
}

/** The body the mock answers would have arrived in — so `:last` teaches the same shape offline. */
export function mockBody(
  answers: ReadonlyArray<[string, Answer | undefined]>,
  model: string,
): Json {
  const map: Record<string, Json> = {};
  for (const [name, a] of answers) {
    if (!a) {
      map[name] = null;
    } else if (a.type === "noul") {
      map[name] = { type: "noul", noul: a.noul };
    } else if (a.type === "choice") {
      map[name] = {
        type: "choice",
        choice: a.choice,
        probabilities: { ...a.probabilities },
        confidence: a.confidence,
      };
    } else {
      map[name] = {
        type: "score",
        score: a.score,
        confidence: a.confidence,
        legend: Object.fromEntries([...a.legend].map(([k, v]) => [String(k), v])),
        probabilities: Object.fromEntries([...a.probabilities].map(([k, v]) => [String(k), v])),
      };
    }
  }
  return { model, answers: map, usage: { input_tokens: null, output_tokens: null } };
}
