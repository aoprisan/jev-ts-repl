/**
 * What a session costs: the tokens a request carries, the tokens its answers bring back, and the
 * money that is at rates you supply.
 *
 * Nothing here calls the API. Token counts are an estimate — roughly four characters to a token,
 * one token per punctuation mark, which is how JSON-shaped text usually falls — so treat them as
 * an order of magnitude, not an invoice. The answer side is not guesswork about length: a System
 * One answer has the shape the question asks for, so the estimate prices the real shape, which is
 * why a choice over eight labels costs more to answer than a noul.
 *
 * Rates are yours to set, in dollars per million tokens, because the price of a model is not
 * something an SDK should hardcode: `:cost 0.20/1.00` in the REPL, or `JEV_PRICE=0.20/1.00` in the
 * environment.
 */

import type { Json } from "../json.js";
import { compact } from "../json.js";
import { questionToJson } from "../typesafe/questions.js";
import type { Usage } from "../typesafe/responses.js";
import * as mock from "./mock.js";
import type { Parsed } from "./session.js";
import { type Session, turnsToJson } from "./session.js";

/** Environment variable holding `<input>/<output>` dollars per million tokens. */
export const PRICE_ENV = "JEV_PRICE";

/** Dollars per million tokens, one rate for what goes up and one for what comes back. */
export interface Rates {
  /** Dollars per million input tokens. */
  readonly input: number;
  /** Dollars per million output tokens. */
  readonly output: number;
}

/** What one question adds to a request and to the answers. */
export interface QuestionEstimate {
  readonly name: string;
  /** `noul`, `choice`, `score`, or `raw` for a hand-built question object. */
  readonly kind: string;
  /** Tokens the question itself contributes to the request. */
  readonly inputTokens: number;
  /** Tokens its answer is expected to contribute to the response. */
  readonly outputTokens: number;
  /** True when the answer shape could not be derived and a noul-sized answer was assumed. */
  readonly assumed: boolean;
}

/** The token side of a call: where they go, and how many there are. */
export interface Estimate {
  readonly model: string;
  /** Tokens in the state being judged. */
  readonly stateTokens: number;
  /** Tokens in the keys, braces and model name wrapped around the request. */
  readonly envelopeTokens: number;
  /** Tokens in the braces wrapped around the answers. */
  readonly answerEnvelopeTokens: number;
  readonly questions: readonly QuestionEstimate[];
  /** State, questions and envelope together. */
  readonly inputTokens: number;
  /** Every expected answer, plus its envelope. */
  readonly outputTokens: number;
}

/** Dollars, split the way the rates are. */
export interface Cost {
  readonly input: number;
  readonly output: number;
  readonly total: number;
}

/** A question shape this SDK does not model: assume an answer the size of a noul's. */
const ASSUMED_ANSWER = '"name":{"type":"noul","noul":0.123}';

/**
 * Tokens in a piece of text, estimated: a run of letters is a token per four characters, digits
 * run denser, a run of punctuation pairs up the way `":"` and `"},` do in a real vocabulary, and a
 * CJK character is a token on its own. Whitespace rides along with the token beside it. No
 * tokenizer is shipped or downloaded to do this; the API reports the real counts in `usage` once a
 * call has been made.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  let letters = 0;
  let digits = 0;
  let marks = 0;
  const flush = (): void => {
    if (letters > 0) tokens += Math.ceil(letters / 4);
    if (digits > 0) tokens += Math.ceil(digits / 3);
    if (marks > 0) tokens += Math.ceil(marks / 2);
    letters = 0;
    digits = 0;
    marks = 0;
  };
  for (const ch of text) {
    if (/\s/u.test(ch)) {
      // Whitespace rides along with the token beside it, so it only ends a run.
      flush();
      continue;
    }
    // Anything above the CJK block is a character per token or worse; Latin text is far denser.
    if ((ch.codePointAt(0) as number) >= 0x2e80) {
      flush();
      tokens += 1;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      if (letters > 0 || marks > 0) flush();
      digits += 1;
      continue;
    }
    if (/\p{L}/u.test(ch)) {
      if (digits > 0 || marks > 0) flush();
      letters += 1;
      continue;
    }
    if (letters > 0 || digits > 0) flush();
    marks += 1;
  }
  flush();
  return tokens;
}

/** Tokens in a JSON value, as it goes on the wire. */
export function estimateJsonTokens(value: Json): number {
  return estimateTokens(compact(value));
}

/** Estimate one call: what the session sends, and what its answers come back as. */
export function estimate(session: Session, model: string): Estimate {
  const questionsJson = session.questionsJson();
  const stateTokens = estimateJsonTokens(session.state);
  const envelopeTokens = estimateTokens(compact({ state: "", model, questions: {} }));
  const answerEnvelopeTokens = estimateTokens(compact({ model, answers: {} }));

  const questions = session.questions.map(([name, question]): QuestionEstimate => {
    const json = questionToJson(question);
    const kind =
      typeof json === "object" &&
      json !== null &&
      !Array.isArray(json) &&
      typeof json["type"] === "string"
        ? json["type"]
        : "raw";
    const answer = mock.answer(session.state, name, json);
    const body = answer ? mock.mockBody([[name, answer]], model) : undefined;
    const shape =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? body["answers"]
        : undefined;
    return {
      name,
      kind,
      inputTokens: estimateTokens(`${compact(name)}:${compact(json)}`),
      outputTokens:
        shape === undefined ? estimateTokens(ASSUMED_ANSWER) : estimateJsonTokens(shape),
      assumed: shape === undefined,
    };
  });

  const inputTokens =
    stateTokens + envelopeTokens + questions.reduce((sum, q) => sum + q.inputTokens, 0);
  const outputTokens = answerEnvelopeTokens + questions.reduce((sum, q) => sum + q.outputTokens, 0);
  return {
    model,
    stateTokens,
    envelopeTokens,
    answerEnvelopeTokens,
    questions,
    inputTokens,
    outputTokens,
  };
}

/**
 * What a conversation has cost, as opposed to what one call costs.
 *
 * A thread is not cheap the way it looks: the state is sent whole every time, so asking again
 * after each turn is a call per turn over a state that keeps growing, and the tokens add up
 * faster than the transcript does. This is the number that surprises people, so it is worth
 * printing next to the per-call one.
 */
export interface Thread {
  /** Turns in the state. */
  readonly turns: number;
  /** One estimate per turn: what asking after that turn cost. */
  readonly calls: readonly Estimate[];
  /** Every call's input tokens, added up. */
  readonly inputTokens: number;
  /** Every call's output tokens, added up. */
  readonly outputTokens: number;
}

/** Estimate a call per turn, or `undefined` when the state is not a conversation. */
export function thread(session: Session, model: string): Thread | undefined {
  const turns = session.turns();
  if (turns === undefined) return undefined;
  const calls = turns.map((_, i) => {
    const soFar = session.clone();
    soFar.state = turnsToJson(turns.slice(0, i + 1));
    return estimate(soFar, model);
  });
  return {
    turns: turns.length,
    calls,
    inputTokens: calls.reduce((sum, c) => sum + c.inputTokens, 0),
    outputTokens: calls.reduce((sum, c) => sum + c.outputTokens, 0),
  };
}

/** Price a pair of token counts. */
export function price(inputTokens: number, outputTokens: number, rates: Rates): Cost {
  const input = (inputTokens / 1_000_000) * rates.input;
  const output = (outputTokens / 1_000_000) * rates.output;
  return { input, output, total: input + output };
}

/** Price an estimate. */
export function priceEstimate(estimated: Estimate, rates: Rates): Cost {
  return price(estimated.inputTokens, estimated.outputTokens, rates);
}

/**
 * Price what a call actually used. `undefined` when the API reported no counts, because a made-up
 * number is worse than none.
 */
export function priceUsage(usage: Usage, rates: Rates): Cost | undefined {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return price(inputTokens, outputTokens, rates);
}

/** `0.20/1.00`, `0.20 1.00`, `$0.20, $1.00` — input first, output second, per million tokens. */
export function parseRates(text: string): Parsed<Rates> {
  const parts = text
    .split(/[\s/,]+/)
    .map((p) => p.trim().replace(/^\$/, ""))
    .filter((p) => p !== "");
  if (parts.length !== 2) {
    return {
      ok: false,
      error: "Two rates, input then output, in dollars per million tokens: :cost 0.20/1.00",
    };
  }
  const [input, output] = parts.map(Number) as [number, number];
  for (const n of [input, output]) {
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `${JSON.stringify(text)} is not a pair of dollar amounts.` };
    }
  }
  return { ok: true, value: { input, output } };
}

/** Rates from `JEV_PRICE`; `undefined` when it is unset or malformed. */
export function ratesFromEnv(value: string | undefined): Rates | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = parseRates(value);
  return parsed.ok ? parsed.value : undefined;
}

/** `$0.20/$1.00 per Mtok`. */
export function formatRates(rates: Rates): string {
  return `$${amount(rates.input)}/$${amount(rates.output)} per Mtok`;
}

/** The same pair as `JEV_PRICE` takes: `0.20/1.00`. */
export function ratesValue(rates: Rates): string {
  return `${amount(rates.input)}/${amount(rates.output)}`;
}

/** Dollars, with enough decimals to be readable at the size a single call costs. */
export function usd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.000001) return "<$0.000001";
  const digits = amount >= 1 ? 2 : amount >= 0.01 ? 4 : 6;
  return `$${amount.toFixed(digits)}`;
}

/** Rates are dollars: two decimals unless the rate is finer than a cent. */
function amount(n: number): string {
  return Number.isInteger(Math.round(n * 100) - n * 100) ? n.toFixed(2) : String(n);
}
