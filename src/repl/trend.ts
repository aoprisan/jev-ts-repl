/**
 * A rubric followed across a conversation: every question asked again after each turn, and what
 * it said drawn as one line per question.
 *
 * A single call over a thread says where the answer ended up. It does not say when it got there —
 * whether urgency was clear from the first message or only arrived with the third — and that is
 * usually the thing worth knowing about a rubric meant to run on a live conversation. This module
 * is the pure half: the prefixes to ask, and the lines to draw from what came back.
 */

import type { Question } from "../typesafe/questions.js";
import type { Answer } from "../typesafe/responses.js";
import { roundedLevel } from "../typesafe/responses.js";
import type { Line } from "../tui/style.js";
import { line, span } from "../tui/style.js";
import { bold, colorFor, dim } from "./format.js";
import type { Answered } from "./headless.js";
import type { Session } from "./session.js";
import { turnsToJson } from "./session.js";

/**
 * The session once per turn: the first turn, the first two, and so on up to the whole thread.
 * Empty when the state is not a conversation.
 *
 * Each prefix is written with `turnsToJson`, the same way `cost.thread` prices it and a cases file
 * labelled `by_turn` sends it, so the three agree on what "the conversation after turn 2" is.
 */
export function prefixes(session: Session): Session[] {
  const turns = session.turns();
  if (turns === undefined) return [];
  return turns.map((_, i) => {
    const soFar = session.clone();
    soFar.state = turnsToJson(turns.slice(0, i + 1));
    return soFar;
  });
}

/** One question across the turns. */
export interface Series {
  readonly name: string;
  readonly kind: Question["kind"];
  /**
   * The number at each turn: a noul's probability, the probability of the label a choice ended on,
   * a score's weighted level. Empty when some turn came back without an answer.
   */
  readonly values: readonly number[];
  /** What a full bar means: 1 for a probability, the highest level for a score. */
  readonly top: number;
  /** What the question said at each turn, in words: `yes`, a label, `level 2`. */
  readonly readings: readonly string[];
  /** For a choice, the label it chose at the last turn — the one `values` follows. */
  readonly label?: string;
}

/**
 * Line each question up across the turns.
 *
 * A choice is followed through the label it ended on, so the line shows that label gaining ground
 * (or not) rather than jumping between whichever label led at each turn; the readings still name
 * the leader turn by turn, which is where a change of mind shows.
 */
export function series(
  session: Session,
  perTurn: ReadonlyArray<readonly Answered[]>,
  threshold: number,
): Series[] {
  return session.questions.map(([name, question]) => {
    const answers = perTurn.map((answered) => answered.find(([n]) => n === name)?.[1]);
    const kind = question.kind;
    const missing: Series = { name, kind, values: [], top: 1, readings: [] };
    if (answers.length === 0 || answers.some((a) => a === undefined || a.type !== kind)) {
      return missing;
    }
    const all = answers as Answer[];
    const last = all[all.length - 1] as Answer;
    if (last.type === "noul") {
      const at = session.thresholdOf(name, threshold);
      const values = all.map((a) => (a.type === "noul" ? a.noul : 0));
      return { name, kind, values, top: 1, readings: values.map((p) => (p >= at ? "yes" : "no")) };
    }
    if (last.type === "choice") {
      const label = last.choice;
      return {
        name,
        kind,
        values: all.map((a) => (a.type === "choice" ? (a.probabilities[label] ?? 0) : 0)),
        top: 1,
        readings: all.map((a) => (a.type === "choice" ? a.choice : "")),
        label,
      };
    }
    const top = Math.max(0, last.legend.size - 1);
    return {
      name,
      kind,
      values: all.map((a) => (a.type === "score" ? a.score : 0)),
      top,
      readings: all.map((a) => (a.type === "score" ? `level ${roundedLevel(a)}` : "")),
    };
  });
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/**
 * One block per value, as tall as the value is of `top`. The scale is fixed rather than fitted to
 * the values, so a noul that sits at 0.9 all the way through reads as high and flat, not as noise.
 */
export function sparkline(values: readonly number[], top: number): string {
  return values
    .map((v) => {
      const share = top <= 0 ? 0 : Math.min(1, Math.max(0, v / top));
      return BLOCKS[Math.round(share * 7)] as string;
    })
    .join("");
}

/** `turn 3 yes · turn 4 no`, or `no throughout` when it never changed its mind. */
export function changes(readings: readonly string[]): string {
  const out: string[] = [];
  for (let i = 1; i < readings.length; i++) {
    if (readings[i] !== readings[i - 1]) out.push(`turn ${i + 1} ${readings[i] as string}`);
  }
  return out.length === 0 ? `${readings[0] ?? ""} throughout` : out.join(" · ");
}

/** `0.12 → 0.91`, with a choice's label in front and a score's scale behind. */
function summary(one: Series): string {
  const first = (one.values[0] ?? 0).toFixed(2);
  const last = (one.values[one.values.length - 1] ?? 0).toFixed(2);
  if (one.label !== undefined) return `${one.label} ${first} → ${last}`;
  if (one.kind === "score") return `${first} → ${last} of ${one.top}`;
  return `${first} → ${last}`;
}

/** One line per question: the spark, where it started and ended, and every turn it changed. */
export function trendLines(all: readonly Series[]): Line[] {
  const width = all.reduce((wide, one) => Math.max(wide, [...one.name].length), 0);
  const summaries = all.map((one) => (one.values.length === 0 ? "" : summary(one)));
  const summaryWidth = summaries.reduce((wide, text) => Math.max(wide, [...text].length), 0);
  return all.map((one, at) => {
    const head = [
      span("  "),
      bold(padEnd(one.name, width)),
      span("  "),
      span(padEnd(one.kind, 8), { fg: colorFor(one.kind) }),
    ];
    if (one.values.length === 0) return line([...head, dim("no answer to follow")]);
    return line([
      ...head,
      span(sparkline(one.values, one.top), { fg: colorFor(one.kind) }),
      span("  "),
      span(padEnd(summaries[at] as string, summaryWidth)),
      span("  "),
      dim(changes(one.readings)),
    ]);
  });
}

function padEnd(text: string, width: number): string {
  const length = [...text].length;
  return length >= width ? text : text + " ".repeat(width - length);
}
