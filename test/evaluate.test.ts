/** Scoring a rubric: the cases file, the metrics, the runner and the two reports. */

import { describe, expect, it } from "vitest";

import * as evaluate from "../src/repl/evaluate.js";
import * as headless from "../src/repl/headless.js";
import { Session } from "../src/repl/session.js";
import { raw } from "../src/typesafe/questions.js";

const PAGE = `A payout failed for the third time.
---
is_urgent? The message conveys urgency
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
  sales = Pricing and plans
frustration: How frustrated the customer appears
  Calm < Frustrated but civil < Very angry
`;

function session(): Session {
  const loaded = headless.load(PAGE);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

/** The cases, or the message that says why there are none. */
function cases(text: string, s: Session = session()): evaluate.Case[] {
  const parsed = evaluate.parseCases(text, s);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function why(text: string, s: Session = session()): string {
  const parsed = evaluate.parseCases(text, s);
  if (parsed.ok) throw new Error("expected these cases to be rejected");
  return parsed.error;
}

describe("the cases file", () => {
  it("reads a labelled state per line", () => {
    const parsed = cases(
      [
        '{"id": "t-001", "state": "Stripe has been down for 3 days", "expect": {"is_urgent": true}}',
        '{"state": {"subject": "Invoice"}, "expect": {"department": "billing", "frustration": 0}}',
      ].join("\n"),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ line: 1, id: "t-001", expect: { is_urgent: { yes: true } } });
    expect(parsed[1]?.state).toEqual({ subject: "Invoice" });
    expect(parsed[1]?.id).toBeUndefined();
    expect(parsed[1]?.expect["frustration"]).toEqual({ kind: "score", level: 0 });
  });

  it("numbers a case by its line, not by its place in the file", () => {
    const parsed = cases(
      [
        "",
        '{"state": "a", "expect": {"is_urgent": true}}',
        "",
        "  ",
        '{"state": "b", "expect": {"is_urgent": false}}',
        "",
      ].join("\n"),
    );
    expect(parsed.map((c) => c.line)).toEqual([2, 5]);
  });

  it("takes a score as the text of one of its levels", () => {
    const parsed = cases('{"state": "a", "expect": {"frustration": "Very angry"}}');
    expect(parsed[0]?.expect["frustration"]).toEqual({ kind: "score", level: 2 });
  });

  it("says which line is wrong, and what is wrong with it", () => {
    expect(why("not json")).toMatch(/^cases line 1: not valid JSON/);
    expect(why("[1, 2]")).toBe("cases line 1: expected a JSON object with `state` and `expect`.");
    expect(why('{"expect": {"is_urgent": true}}')).toContain("missing `state`");
    expect(why('{"state": "  ", "expect": {"is_urgent": true}}')).toContain("`state` is empty");
    expect(why('{"state": "a"}')).toContain("missing `expect`");
    expect(why('{"state": "a", "expect": {}}')).toContain("at least one question");
    expect(why('{"state": "a", "id": 7, "expect": {"is_urgent": true}}')).toContain("`id` must be");
    expect(why('{"state": "a", "expect": {"nope": true}}')).toContain('no question named "nope"');
    expect(why('{"state": "a", "expect": {"is_urgent": "yes"}}')).toContain(
      "expected true or false",
    );
    expect(why('{"state": "a", "expect": {"department": "legal"}}')).toContain(
      "billing, technical, sales",
    );
    expect(why('{"state": "a", "expect": {"frustration": 3}}')).toContain("from 0 to 2");
    expect(why('{"state": "a", "expect": {"frustration": "Livid"}}')).toContain("from 0 to 2");
    expect(why("\n\nnot json")).toMatch(/^cases line 3:/);
  });

  it("refuses to score a raw question", () => {
    const s = session();
    s.insert("tone", raw({ type: "sentiment" }));
    expect(why('{"state": "a", "expect": {"tone": true}}', s)).toContain("raw questions cannot");
  });

  it("refuses a file with nothing in it", () => {
    expect(why("\n \n")).toBe("the cases file holds no cases.");
  });
});
