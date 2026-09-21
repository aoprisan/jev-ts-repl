/**
 * What the "+" buttons add.
 *
 * A seed has to be a question the notation can read back. The build tab writes the page and then
 * reads it again, so a seed that does not parse takes the whole tab down with it — which is what
 * a choice with a single option did: one is not a choice, the page stopped parsing, and every add
 * after it was refused with "fix the page's problems first".
 */

import type { ChoiceOption, Question } from "jev-repl/core";
import { choice, noul, score } from "jev-repl/core";

/** The question kinds the build tab can add. */
export type Kind = "noul" | "choice" | "score";

export const KINDS: readonly Kind[] = ["noul", "choice", "score"];

/** A new question of `kind`, filled in enough to be a valid page on its own. */
export function seed(kind: Kind): Question {
  switch (kind) {
    case "noul":
      return noul("What this asks");
    case "choice":
      return choice("What this asks", [
        ["first", null] as ChoiceOption,
        ["second", null] as ChoiceOption,
      ]);
    case "score":
      return score("What this asks", ["low", "high"]);
  }
}
