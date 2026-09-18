/**
 * The one-line commands, applied to a session. The presets and the lesson track are written in
 * them, and the parsers are the REPL's own — the notation cannot drift between the two hosts.
 */

import type { Session } from "jev-repl/core";
import { parseChoice, parseNoul, parseRaw, parseScore } from "jev-repl/core";

export function apply(session: Session, command: string): string | undefined {
  const text = command.trim();
  if (text === "") return undefined;
  if (!text.startsWith(":")) {
    session.state = text;
    return undefined;
  }
  const at = text.search(/\s/);
  const name = at === -1 ? text : text.slice(0, at);
  const args = at === -1 ? "" : text.slice(at + 1).trim();

  switch (name) {
    case ":state":
      session.state = args;
      return undefined;
    case ":model":
      session.model = args === "" ? undefined : args;
      return undefined;
    case ":noul":
    case ":choice":
    case ":score":
    case ":raw": {
      const parse =
        name === ":noul"
          ? parseNoul
          : name === ":choice"
            ? parseChoice
            : name === ":score"
              ? parseScore
              : parseRaw;
      const parsed = parse(args);
      if (!parsed.ok) return parsed.error;
      const [key, question] = parsed.value;
      session.insert(key, question);
      return undefined;
    }
    default:
      return `\`${name}\` is a terminal-only command`;
  }
}

/** Replay a whole script (a preset), stopping at the first line that will not parse. */
export function applyAll(session: Session, script: readonly string[]): string | undefined {
  for (const command of script) {
    const error = apply(session, command);
    if (error !== undefined) return error;
  }
  return undefined;
}
