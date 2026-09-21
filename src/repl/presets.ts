/** Ready-made sessions to poke at: `:preset <name>`. */

import { render } from "./sketch.js";
import { parseChoice, parseNoul, parseRaw, parseScore, Session } from "./session.js";

export interface Preset {
  readonly name: string;
  readonly about: string;
  /** Commands replayed as if typed. */
  readonly script: readonly string[];
}

export const PRESETS: readonly Preset[] = [
  {
    name: "triage",
    about: "Route a support ticket: department, frustration, urgency",
    script: [
      ":state Hi, I've been trying to connect my Stripe account for 3 days and it keeps failing. I'm losing sales. Please help ASAP.",
      ":choice department Which team should handle this | billing=Payment or subscription issues | technical=Bugs or integration problems | sales=Pricing or account questions",
      ":score frustration How frustrated the customer appears | Calm, just stating facts | Frustrated but civil | Very angry, strong language",
      ":noul is_urgent The message conveys urgency or time-sensitivity",
    ],
  },
  {
    name: "moderation",
    about: "Screen user content before it is published",
    script: [
      ":state You people are useless. Fix my order or I'll come down there myself.",
      ":noul is_threat The message threatens violence against a person | yes: A stated intent to harm someone | no: Anger, insults or profanity with no threat of harm",
      ":score severity How far out of bounds this is | Fine as written | Rude but publishable | Abusive, needs review | Remove immediately",
      ":choice action What to do with this content | publish=Nothing wrong with it | flag=A human should look | block=Clearly violates the rules",
    ],
  },
  {
    name: "lead",
    about: "Qualify an inbound sales email",
    script: [
      ":state Hi — we're a 300-person logistics company evaluating vendors this quarter. Budget is approved. Can you send pricing for 250 seats?",
      ":noul has_budget The sender indicates budget is available or approved",
      ":score readiness How close this is to a buying decision | Just browsing | Researching options | Actively evaluating vendors | Ready to buy now",
      ":choice size Company size implied by the message | smb=Under 50 people | mid=50 to 1000 people | enterprise=Over 1000 people",
    ],
  },
  {
    name: "reply",
    about: "Grade a draft reply before it is sent",
    script: [
      ':state Draft reply: "That\'s not our problem. You configured it wrong. Read the docs."',
      ":noul answers_question The reply actually addresses what was asked",
      ":score tone Tone of the reply | Warm and helpful | Neutral | Curt | Hostile",
      ":noul safe_to_send This reply can go out without a human reading it first | yes: Accurate, on-topic and civil | no: Rude, evasive or likely to make things worse",
    ],
  },
];

export function find(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}

/**
 * A preset as a sketch page — the same session `:preset` builds, written out the way a file is.
 *
 * The scripts are REPL lines because that is how the REPL loads them; anything outside a terminal
 * (the MCP server, a `jev` example, the docs) wants the page instead.
 */
export function page(preset: Preset): string {
  const session = new Session();
  for (const line of preset.script) {
    const at = line.search(/\s/);
    const command = at === -1 ? line : line.slice(0, at);
    const args = at === -1 ? "" : line.slice(at + 1);
    if (command === ":state") {
      session.state = args;
      continue;
    }
    const parsed =
      command === ":noul"
        ? parseNoul(args)
        : command === ":choice"
          ? parseChoice(args)
          : command === ":score"
            ? parseScore(args)
            : command === ":raw"
              ? parseRaw(args)
              : undefined;
    // A preset that does not parse is a bug in this file, not in the caller's input.
    if (parsed?.ok) session.insert(...parsed.value);
  }
  return render(session);
}
