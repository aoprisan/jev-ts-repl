/**
 * The three question kinds the notation writes, and a blank question of each.
 *
 * A seed has to be a question the notation can read back. Anything that edits a page through a
 * session writes the page and then reads it again, so a seed that does not parse — a choice with
 * a single option, which is not a choice — takes the whole editor down with it: the questions stop
 * being readable and every add after it is refused. The round trip is the contract, and a test
 * holds these to it.
 */

import type { Question } from "../typesafe/questions.js";
import { choice, noul, score } from "../typesafe/questions.js";

/** A question kind the notation has a shape for; anything else is a raw question object. */
export type Kind = "noul" | "choice" | "score";

/** The kinds, in the order a type picker cycles through them. */
export const KINDS: readonly Kind[] = ["noul", "choice", "score"];

/** A new question of `kind`, filled in enough to be a page that parses. */
export function seed(kind: Kind): Question {
  switch (kind) {
    case "noul":
      return noul("What this asks");
    case "choice":
      return choice("What this asks", [
        ["first", null],
        ["second", null],
      ]);
    case "score":
      return score("What this asks", ["low", "high"]);
  }
}
