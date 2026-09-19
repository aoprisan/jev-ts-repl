/** jev with no terminal: a page in, one answer out. */

import { describe, expect, it } from "vitest";

import * as headless from "../src/repl/headless.js";
import { parseRates } from "../src/repl/cost.js";
import { Session, parseNoul } from "../src/repl/session.js";
import type { SystemOneResponse } from "../src/typesafe/responses.js";
import { makeSystemOneResponse } from "../src/typesafe/responses.js";

const PAGE = `The payout failed again, third time this month.
---
is_urgent? The message conveys urgency
  yes: A deadline or money being lost now
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
frustration: How frustrated the customer appears
  Calm < Frustrated but civil < Very angry
`;

function session(): Session {
  const loaded = headless.load(PAGE);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function rates(text: string) {
  const parsed = parseRates(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

describe("reading the input", () => {
  it("reads a sketch page", () => {
    const s = session();
    expect(s.questions.map(([name]) => name)).toEqual(["is_urgent", "department", "frustration"]);
    expect(s.state).toContain("payout failed");
  });

  it("reads a request body, so a `jev json` round-trips back in", () => {
    const body = session().requestJson("jev-latest");
    const loaded = headless.load(body);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.requestJson("jev-latest")).toBe(body);
  });

  it("tells a page from a body by the text, because stdin has no file name", () => {
    const loaded = headless.load('  {"state": "hi", "questions": {}}');
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.state).toBe("hi");
  });

  it("refuses an empty input rather than sending an empty request", () => {
    const loaded = headless.load("   \n  ");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/empty/);
  });

  it("points at the line a bad page went wrong on", () => {
    const loaded = headless.load("a state\n---\nbroken?\n");
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toMatch(/^line 3: /);
  });
});

describe("check", () => {
  it("says what the page parsed into", () => {
    const checked = headless.checkText(PAGE);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value).toContain("3 questions");
      expect(checked.value).toContain("is_urgent (noul)");
      expect(checked.value).toContain("frustration (score)");
    }
  });

  it("reports every problem, not just the first", () => {
    const checked = headless.checkText("a state\n---\nbroken?\nalso_broken?\n");
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.split("\n")).toHaveLength(2);
  });

  it("warns that a page with no state cannot be sent yet", () => {
    const checked = headless.checkText("---\nis_urgent? conveys urgency\n");
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value).toContain("no state");
  });

  it("passes a request body through the same check", () => {
    const checked = headless.checkText('{"state": "hi", "questions": {}}');
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.value).toContain("0 questions");
  });
});

describe("what can be sent", () => {
  it("will not send a request that asks nothing", () => {
    const s = Session.from({ state: "hi", questions: [] });
    expect(headless.sendable(s)).toMatch(/No questions/);
  });

  it("will not send a request with nothing to judge", () => {
    const parsed = parseNoul("is_urgent conveys urgency");
    if (!parsed.ok) throw new Error(parsed.error);
    const s = Session.from({ state: "", questions: [parsed.value] });
    expect(headless.sendable(s)).toMatch(/No state/);
  });

  it("is happy with a state and a question", () => {
    expect(headless.sendable(session())).toBeUndefined();
  });
});

describe("what it prints", () => {
  it("prints the request body a call would POST, newline-terminated", () => {
    const text = headless.requestText(session(), "jev-latest");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ model: "jev-latest" });
  });

  it("prints the cost table, and says how to price it when no rates are set", () => {
    const text = headless.costText(session(), "jev-latest", undefined);
    expect(text).toContain("total");
    expect(text).toContain("--price 0.20/1.00");
  });

  it("prices the table when rates are given", () => {
    const text = headless.costText(session(), "jev-latest", rates("0.20/1.00"));
    expect(text).toContain("per call");
    expect(text).toContain("$0.20/$1.00 per Mtok");
  });

  it("prints the session as code in either language", () => {
    const s = session();
    expect(headless.codeText(s, "ts", "jev-latest", 0.5)).toContain("client.systemOne");
    expect(headless.codeText(s, "rust", "jev-latest", 0.5)).toContain("typesafe");
    expect(headless.codeText(s, "ts", "jev-latest", 0.5).endsWith("\n")).toBe(true);
  });
});

describe("answers", () => {
  it("simulates one answer per question, deterministically", () => {
    const s = session();
    const once = headless.mockAnswers(s);
    const twice = headless.mockAnswers(s);
    expect(once.map(([name]) => name)).toEqual(["is_urgent", "department", "frustration"]);
    expect(headless.answersJson(once, "jev-latest")).toBe(
      headless.answersJson(twice, "jev-latest"),
    );
  });

  it("renders the answer page the REPL draws, without the colour", () => {
    const text = headless.answersText(headless.mockAnswers(session()), 0.5);
    expect(text).toContain("is_urgent");
    expect(text).toContain("threshold 0.50");
    expect(text).not.toContain("\u001b[");
  });

  it("says which question went unanswered instead of dropping it", () => {
    const text = headless.answersText([["mystery", undefined]], 0.5);
    expect(text).toContain("mystery: no answer came back");
  });

  it("prints a raw body that parses, for --json", () => {
    const body = headless.answersJson(headless.mockAnswers(session()), "jev-latest");
    expect(JSON.parse(body)).toMatchObject({ model: "jev-latest" });
  });

  it("lines a live response up with the questions that were asked", () => {
    const response: SystemOneResponse = makeSystemOneResponse(
      "jev-1",
      { inputTokens: 120, outputTokens: 30 },
      new Map([["is_urgent", { type: "noul", noul: 0.9 }]]),
      { answers: {} },
      { status: 200, headers: new Headers(), attempts: 1 },
    );
    const answered = headless.liveAnswers(session(), response);
    expect(answered).toHaveLength(3);
    expect(answered[0]?.[1]).toMatchObject({ noul: 0.9 });
    expect(answered[1]?.[1]).toBeUndefined();
  });

  it("prefers the counted usage over the estimate, and prices it", () => {
    const counted = headless.usageText(session(), "jev-latest", rates("0.20/1.00"), {
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(counted).toContain("120 in / 30 out");
    expect(counted).toContain("$");
    expect(counted).not.toContain("≈");
  });

  it("falls back to the estimate, and says so, when nothing was counted", () => {
    const estimated = headless.usageText(session(), "jev-latest", undefined, undefined);
    expect(estimated).toContain("≈");
    expect(estimated).toContain("estimated");
  });
});

describe("the command names", () => {
  it("knows its own subcommands", () => {
    expect(headless.isCommand("run")).toBe(true);
    expect(headless.isCommand("check")).toBe(true);
    expect(headless.isCommand("triage.jev")).toBe(false);
    expect(headless.isCommand("--help")).toBe(false);
  });
});
