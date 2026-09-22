/** The thing you are building in the REPL: a `state`, some named questions, a model. */

import type { Json, JsonObject } from "../json.js";
import { compact, isEmptyValue, isObject, pretty, tryParse } from "../json.js";
import type { Question } from "../typesafe/questions.js";
import {
  choice as makeChoice,
  noul as makeNoul,
  questionFromJson,
  questionToJson,
  raw as makeRaw,
  score as makeScore,
  withOption,
} from "../typesafe/questions.js";

/** A question under construction, kept in the order it was added. */
export type Entry = [name: string, question: Question];

/** Either a parsed value, or the message explaining what to type instead. */
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const err = <T>(error: string): Parsed<T> => ({ ok: false, error });

/**
 * One turn of a conversation held as the state: who spoke, and what they said.
 *
 * A conversation is not a new field on the wire — it is the `state`, shaped as an array. The
 * questions stay fixed and the state grows, which is the whole point: the same rubric, re-read
 * after every reply, so a noul can be watched moving rather than sampled once.
 */
export interface Turn {
  /** The speaker, when the line names one. */
  readonly who?: string;
  /** What was said. */
  readonly said: string;
}

/** Keys a turn's speaker may arrive under, so a transcript from elsewhere still reads as one. */
const WHO_KEYS = ["who", "role", "speaker", "from"] as const;
/** Keys a turn's text may arrive under, for the same reason. */
const SAID_KEYS = ["said", "text", "content", "message"] as const;

/**
 * Read a state as a conversation, or `undefined` when it is not one.
 *
 * Only an array whose every element carries some text counts, so a string state, a row of
 * numbers or an object of fields is never mistaken for a thread and quietly reshaped. The key
 * names are read loosely because a transcript pasted in from a chat API is still a transcript.
 */
export function turnsOf(state: Json): Turn[] | undefined {
  if (!Array.isArray(state) || state.length === 0) return undefined;
  const turns: Turn[] = [];
  for (const item of state) {
    if (!isObject(item)) return undefined;
    const said = SAID_KEYS.map((k) => item[k]).find((v) => typeof v === "string");
    if (typeof said !== "string") return undefined;
    const who = WHO_KEYS.map((k) => item[k]).find((v) => typeof v === "string");
    turns.push(typeof who === "string" && who !== "" ? { who, said } : { said });
  }
  return turns;
}

/** Turns as they go on the wire: `who` only when there is one, so nothing empty is paid for. */
export function turnsToJson(turns: readonly Turn[]): Json {
  return turns.map((t): JsonObject =>
    t.who === undefined ? { said: t.said } : { who: t.who, said: t.said },
  );
}

/** `customer: The payout failed again` — one turn on one line. */
export function turnText(turn: Turn): string {
  return turn.who === undefined ? turn.said : `${turn.who}: ${turn.said}`;
}

/** Everything the next `:ask` will send. */
export class Session {
  /** The text or JSON the model reasons about. */
  state: Json = "";
  /** Named questions, in insertion order. */
  questions: Entry[] = [];
  /** Per-session model override; `undefined` means the client default. */
  model: string | undefined;
  /**
   * Each question's decision bar, by name: a noul's threshold, or the confidence a choice or a
   * score has to reach before it is acted on. It lives on the page and never goes on the wire —
   * it is what the caller does with the answer, not part of the question.
   */
  bars: Map<string, number> = new Map();

  static from(parts: {
    state: Json;
    questions: Entry[];
    model?: string | undefined;
    bars?: ReadonlyMap<string, number> | undefined;
  }): Session {
    const session = new Session();
    session.state = parts.state;
    session.questions = parts.questions;
    session.model = parts.model;
    if (parts.bars !== undefined) session.bars = new Map(parts.bars);
    return session;
  }

  /** The bar written for a question, if the page gives it one. */
  bar(name: string): number | undefined {
    return this.bars.get(name);
  }

  /**
   * The threshold a noul is read at: its own `@threshold` when the page has one, `fallback` — the
   * session-wide `:threshold` or `--threshold` — when it does not. The question's own bar wins
   * because it is the more specific of the two: someone wrote it down for this question.
   */
  thresholdOf(name: string, fallback: number): number {
    const question = this.questions.find(([n]) => n === name)?.[1];
    const bar = this.bars.get(name);
    return question?.kind === "noul" && bar !== undefined ? bar : fallback;
  }

  stateIsEmpty(): boolean {
    return isEmptyValue(this.state);
  }

  /** One-line preview of the state for the side panel. */
  statePreview(): string {
    const turns = this.turns();
    if (turns !== undefined) {
      const last = turns[turns.length - 1] as Turn;
      return `${turns.length} turn${turns.length === 1 ? "" : "s"} · ${turnText(last)}`;
    }
    return typeof this.state === "string" ? this.state : compact(this.state);
  }

  /** The state read as a conversation, or `undefined` when it is something else. */
  turns(): Turn[] | undefined {
    return turnsOf(this.state);
  }

  /**
   * Append a turn to the state.
   *
   * An empty state starts a thread and a thread grows by one. A state that is plain text becomes
   * the first turn, because that is how a session usually begins — one message, then the reply to
   * it. Any other JSON is refused rather than reshaped: whatever it is, it is not a conversation,
   * and guessing at one would lose it.
   */
  addTurn(turn: Turn): Parsed<Turn[]> {
    const seed = this.turns() ?? this.#seedTurns();
    if (seed === undefined) {
      return err("The state is JSON that is not a conversation, so there is no thread to add to.");
    }
    const turns = [...seed, turn];
    this.state = turnsToJson(turns);
    return ok(turns);
  }

  /** Take the last turn back. The last one of all leaves the state empty again. */
  dropTurn(): Turn | undefined {
    const turns = this.turns();
    const last = turns?.[turns.length - 1];
    if (turns === undefined || last === undefined) return undefined;
    const rest = turns.slice(0, -1);
    this.state = rest.length === 0 ? "" : turnsToJson(rest);
    return last;
  }

  /** What a thread starts from: nothing, or the text that was already there. */
  #seedTurns(): Turn[] | undefined {
    if (isEmptyValue(this.state)) return [];
    return typeof this.state === "string" ? [{ said: this.state }] : undefined;
  }

  /** Add a question, or replace one of the same name in place. Returns whether it replaced one. */
  insert(name: string, question: Question): boolean {
    const at = this.questions.findIndex(([n]) => n === name);
    if (at >= 0) {
      // A threshold means nothing to a choice, nor a confidence bar to a noul.
      if (this.questions[at]?.[1].kind !== question.kind) this.bars.delete(name);
      this.questions[at] = [name, question];
      return true;
    }
    this.questions.push([name, question]);
    return false;
  }

  remove(name: string): boolean {
    const before = this.questions.length;
    this.questions = this.questions.filter(([n]) => n !== name);
    this.bars.delete(name);
    return this.questions.length !== before;
  }

  indexOf(name: string): number {
    const at = this.questions.findIndex(([n]) => n === name);
    return at < 0 ? 0 : at;
  }

  /** The `questions` object, in insertion order. */
  questionsJson(): JsonObject {
    const out: JsonObject = {};
    for (const [name, question] of this.questions) out[name] = questionToJson(question);
    return out;
  }

  /**
   * The exact JSON body the SDK will POST to `/v1/systemone`. Field and question order survive,
   * which is the whole point of showing it.
   */
  requestJson(model: string): string {
    return pretty({ state: this.state, model, questions: this.questionsJson() });
  }

  clone(): Session {
    return Session.from({
      state: this.state,
      questions: this.questions.map(([name, q]) => [name, q] as Entry),
      model: this.model,
      bars: this.bars,
    });
  }
}

/** `name instructions [| yes: ...] [| no: ...]` */
export function parseNoul(args: string): Parsed<Entry> {
  const split = splitName(args, ":noul is_urgent The message conveys urgency");
  if (!split.ok) return split;
  const [name, rest] = split.value;
  const parts = rest.split("|").map((p) => p.trim());
  const instructions = parts.shift() ?? "";
  if (instructions === "") {
    return err("A noul needs instructions: :noul is_urgent The message conveys urgency");
  }
  let question = makeNoul(value(instructions));
  for (const part of parts) {
    const at = part.indexOf(":");
    if (at === -1) {
      return err(`Expected \`yes: …\` or \`no: …\`, got ${JSON.stringify(part)}.`);
    }
    const tag = part.slice(0, at).trim().toLowerCase();
    const text = part.slice(at + 1).trim();
    if (tag === "yes" || tag === "true") {
      question = makeNoul(question.instructions, { ...question.criteria, yes: value(text) });
    } else if (tag === "no" || tag === "false") {
      question = makeNoul(question.instructions, { ...question.criteria, no: value(text) });
    } else {
      return err(`Unknown criterion ${JSON.stringify(tag)}; use \`yes:\` or \`no:\`.`);
    }
  }
  return ok([name, question]);
}

/** `name instructions | label=description | bare_label | …` */
export function parseChoice(args: string): Parsed<Entry> {
  const split = splitName(
    args,
    ":choice department Which team handles this | billing=Payments | technical=Bugs",
  );
  if (!split.ok) return split;
  const [name, rest] = split.value;
  const parts = rest.split("|").map((p) => p.trim());
  const instructions = parts.shift() ?? "";
  if (instructions === "") return err("A choice needs instructions before the first `|`.");
  let question = makeChoice(value(instructions));
  let count = 0;
  for (const part of parts.filter((p) => p !== "")) {
    const at = part.indexOf("=");
    question =
      at === -1
        ? withOption(question, part, null)
        : withOption(question, part.slice(0, at).trim(), value(part.slice(at + 1).trim()));
    count += 1;
  }
  if (count < 2) {
    return err("A choice needs at least two options: … | billing=Payments | technical=Bugs");
  }
  return ok([name, question]);
}

/** `name instructions | level | level | …` */
export function parseScore(args: string): Parsed<Entry> {
  const split = splitName(
    args,
    ":score frustration How frustrated they are | Calm | Annoyed | Furious",
  );
  if (!split.ok) return split;
  const [name, rest] = split.value;
  const parts = rest.split("|").map((p) => p.trim());
  const instructions = parts.shift() ?? "";
  if (instructions === "") return err("A score needs instructions before the first `|`.");
  const levels = parts.filter((p) => p !== "").map(value);
  if (levels.length < 2) {
    return err("A score needs at least two ordered levels: … | Calm | Annoyed | Furious");
  }
  return ok([name, makeScore(value(instructions), levels)]);
}

/** `name {json}` — a hand-built question object. */
export function parseRaw(args: string): Parsed<Entry> {
  const split = splitName(args, ':raw tone {"type": "noul", "instructions": "Polite?"}');
  if (!split.ok) return split;
  const [name, rest] = split.value;
  try {
    return ok([name, makeRaw(JSON.parse(rest) as Json)]);
  } catch (e) {
    return err(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * `who: what they said`, or just what they said.
 *
 * The speaker is the first word and only when that word ends in a colon, so a line typed without
 * one keeps all of its words instead of donating the first to a speaker nobody named.
 */
export function parseTurn(args: string): Parsed<Turn> {
  const text = args.trim();
  const example = ":turn customer: The payout failed again";
  if (text === "") return err(`A turn needs something said. Try: ${example}`);
  const at = text.search(/\s/);
  const head = at === -1 ? text : text.slice(0, at);
  if (!head.endsWith(":") || head.length === 1) return ok({ said: text });
  const said = at === -1 ? "" : text.slice(at + 1).trim();
  if (said === "") return err(`Nothing said after ${JSON.stringify(head)}. Try: ${example}`);
  return ok({ who: head.slice(0, -1), said });
}

function splitName(args: string, example: string): Parsed<[string, string]> {
  const trimmed = args.trim();
  const at = trimmed.search(/\s/);
  if (at === -1) return err(`Missing name or body. Try: ${example}`);
  const name = trimmed.slice(0, at);
  if (name === "") return err(`Missing a question name. Try: ${example}`);
  return ok([name, trimmed.slice(at + 1).trim()]);
}

/**
 * Instructions, descriptions and levels accept any JSON, so `{…}`/`[…]` is parsed as such and
 * anything else is sent as a plain string.
 */
export function value(text: string): Json {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const parsed = tryParse(t);
    if (parsed !== undefined) return parsed;
  }
  return t;
}

/**
 * Rebuild a session from a saved request body (`:open`), keeping typed questions where the `type`
 * is one this SDK models.
 */
export function fromBody(text: string): Parsed<Session> {
  let body: Json;
  try {
    body = JSON.parse(text) as Json;
  } catch (e) {
    return err(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isObject(body)) return err("Expected a JSON object.");
  const questions = body["questions"];
  if (!isObject(questions)) return err("Expected a `questions` object.");
  const model = body["model"];
  return ok(
    Session.from({
      state: body["state"] ?? null,
      questions: Object.entries(questions).map(([name, q]) => [name, questionFromJson(q)] as Entry),
      model: typeof model === "string" ? model : undefined,
    }),
  );
}
