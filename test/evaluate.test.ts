/** Scoring a rubric: the cases file, the metrics, the runner and the two reports. */

import { describe, expect, it } from "vitest";

import * as evaluate from "../src/repl/evaluate.js";
import * as headless from "../src/repl/headless.js";
import { Session } from "../src/repl/session.js";
import { raw } from "../src/typesafe/questions.js";
import type { Answer, Usage } from "../src/typesafe/responses.js";

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

function noul(p: number): Answer {
  return { type: "noul", noul: p };
}

function choice(label: string, confidence: number): Answer {
  return { type: "choice", choice: label, probabilities: { [label]: confidence }, confidence };
}

function score(level: number, confidence: number): Answer {
  return {
    type: "score",
    score: level,
    confidence,
    legend: new Map([
      [0, "Calm"],
      [1, "Frustrated but civil"],
      [2, "Very angry"],
    ]),
    probabilities: new Map([[level, confidence]]),
  };
}

/** One answered case: the answers by question name, and the tokens it reported using. */
function answered(answers: Record<string, Answer>, usage?: Usage): evaluate.Outcome {
  return usage === undefined
    ? { ok: true, answers: Object.entries(answers) }
    : { ok: true, answers: Object.entries(answers), usage };
}

function scored(
  lines: readonly string[],
  outcomes: readonly evaluate.Outcome[],
  options: { threshold?: number; rates?: { input: number; output: number } } = {},
): evaluate.Report {
  const s = session();
  return evaluate.report(s, cases(lines.join("\n"), s), outcomes, {
    model: "jev-latest",
    threshold: options.threshold ?? 0.5,
    rates: options.rates,
  });
}

/** The report for one question, which the tests always know the kind of. */
function question<T extends evaluate.QuestionReport["kind"]>(
  report: evaluate.Report,
  name: string,
): Extract<evaluate.QuestionReport, { kind: T }> {
  const found = report.questions.find((q) => q.name === name);
  if (!found) throw new Error(`no report for ${name}`);
  return found as Extract<evaluate.QuestionReport, { kind: T }>;
}

const URGENT = [
  '{"state": "one", "expect": {"is_urgent": true}}',
  '{"state": "two", "expect": {"is_urgent": true}}',
  '{"state": "three", "expect": {"is_urgent": false}}',
  '{"state": "four", "expect": {"is_urgent": true}}',
];

describe("what a noul scored", () => {
  const report = scored(
    URGENT,
    [0.9, 0.7, 0.3, 0.1].map((p) => answered({ is_urgent: noul(p) })),
  );
  const urgent = question<"noul">(report, "is_urgent");

  it("counts the four corners at the chosen threshold", () => {
    const row = urgent.sweep.find((r) => r.threshold === 0.5);
    expect(row).toMatchObject({ tp: 2, fp: 0, fn: 1, tn: 1, accuracy: 0.75, precision: 1 });
    expect(row?.recall).toBeCloseTo(2 / 3, 12);
    expect(row?.f1).toBeCloseTo(0.8, 12);
    expect(urgent.accuracy).toBe(0.75);
    expect(urgent.cases).toBe(4);
  });

  it("scores the probabilities themselves, threshold or no threshold", () => {
    expect(urgent.brier).toBeCloseTo((0.01 + 0.09 + 0.09 + 0.81) / 4, 12);
  });

  it("sweeps the round thresholds, and the chosen one exactly once", () => {
    expect(urgent.sweep.map((r) => r.threshold)).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9,
    ]);
    const odd = question<"noul">(
      scored(
        URGENT,
        [0.9, 0.7, 0.3, 0.1].map((p) => answered({ is_urgent: noul(p) })),
        { threshold: 0.55 },
      ),
      "is_urgent",
    );
    expect(odd.sweep.map((r) => r.threshold)).toEqual([
      0.1, 0.2, 0.3, 0.4, 0.5, 0.55, 0.6, 0.7, 0.8, 0.9,
    ]);
    expect(odd.sweep.filter((r) => r.threshold === 0.55)).toHaveLength(1);
  });

  it("leaves precision undefined when nothing was called a yes", () => {
    const quiet = question<"noul">(
      scored(
        URGENT,
        [0.1, 0.1, 0.1, 0.1].map((p) => answered({ is_urgent: noul(p) })),
      ),
      "is_urgent",
    );
    const row = quiet.sweep.find((r) => r.threshold === 0.5);
    expect(row?.precision).toBeUndefined();
    expect(row?.recall).toBe(0);
    expect(row?.f1).toBe(0);
  });

  it("breaks a tie on the best f1 by taking the lowest threshold", () => {
    const flat = question<"noul">(
      scored(
        ['{"state": "one", "expect": {"is_urgent": true}}'],
        [answered({ is_urgent: noul(0.95) })],
      ),
      "is_urgent",
    );
    expect(flat.best).toEqual({ threshold: 0.1, f1: 1 });
  });
});

describe("what a choice scored", () => {
  const lines = [
    '{"state": "one", "expect": {"department": "billing"}}',
    '{"state": "two", "expect": {"department": "billing"}}',
    '{"state": "three", "expect": {"department": "technical"}}',
    '{"state": "four", "expect": {"department": "sales"}}',
  ];
  const report = scored(lines, [
    answered({ department: choice("billing", 0.9) }),
    answered({ department: choice("technical", 0.5) }),
    answered({ department: choice("technical", 0.3) }),
    answered({ department: choice("legal", 0.1) }),
  ]);
  const department = question<"choice">(report, "department");

  it("orders the matrix the way the page orders its options", () => {
    expect(department.labels).toEqual(["billing", "technical", "sales", "other"]);
    expect(department.confusion).toEqual([
      [1, 1, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 0, 1],
    ]);
    expect(department.accuracy).toBe(0.5);
  });

  it("shows what a confidence gate buys", () => {
    expect(department.gate.map((row) => row.confidence)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(department.gate.map((row) => row.coverage)).toEqual([1, 0.75, 0.5, 0.25, 0.25]);
    expect(department.gate[0]?.accuracy).toBe(0.5);
    expect(department.gate[4]?.accuracy).toBe(1);
  });

  it("leaves the gate's accuracy undefined when nothing is confident enough", () => {
    const shy = question<"choice">(
      scored(
        ['{"state": "one", "expect": {"department": "billing"}}'],
        [answered({ department: choice("billing", 0.1) })],
      ),
      "department",
    );
    expect(shy.gate[4]).toEqual({ confidence: 0.8, coverage: 0, accuracy: undefined });
  });
});

describe("what a score scored", () => {
  const lines = [
    '{"state": "one", "expect": {"frustration": 0}}',
    '{"state": "two", "expect": {"frustration": 2}}',
    '{"state": "three", "expect": {"frustration": 2}}',
  ];
  const report = scored(lines, [
    answered({ frustration: score(0, 0.8) }),
    answered({ frustration: score(1.4, 0.5) }),
    answered({ frustration: score(0, 0.1) }),
  ]);
  const frustration = question<"score">(report, "frustration");

  it("counts the exact levels, the neighbours and the distance", () => {
    expect(frustration.exact).toBeCloseTo(1 / 3, 12);
    expect(frustration.withinOne).toBeCloseTo(2 / 3, 12);
    expect(frustration.mae).toBeCloseTo(1, 12);
  });

  it("gates on confidence with the exact levels", () => {
    expect(frustration.gate[3]).toEqual({ confidence: 0.6, coverage: 1 / 3, accuracy: 1 });
  });
});

describe("cases that did not answer", () => {
  const lines = [
    '{"id": "t-001", "state": "one", "expect": {"is_urgent": true}}',
    '{"state": "two", "expect": {"is_urgent": true, "department": "billing"}}',
    '{"state": "three", "expect": {"is_urgent": true}}',
  ];
  const report = scored(lines, [
    { ok: false, error: "Timeout  the request did not complete" },
    answered({ is_urgent: noul(0.9) }),
    answered({ is_urgent: noul(0.9) }),
  ]);

  it("names them by line and id, and leaves them out of every metric", () => {
    expect(report.errors).toEqual([
      { case: 1, id: "t-001", message: "Timeout  the request did not complete" },
      { case: 2, message: "no answer came back for department" },
    ]);
    expect(report.cases).toBe(3);
    expect(report.answered).toBe(1);
    expect(question<"noul">(report, "is_urgent").cases).toBe(1);
    expect(report.questions.map((q) => q.name)).toEqual(["is_urgent"]);
  });
});

describe("what the run spent", () => {
  const lines = URGENT.slice(0, 2);
  const usage = { inputTokens: 100, outputTokens: 20 };

  it("sums the counts the API reported, and prices them", () => {
    const report = scored(
      lines,
      [answered({ is_urgent: noul(0.9) }, usage), answered({ is_urgent: noul(0.9) }, usage)],
      { rates: { input: 0.2, output: 1 } },
    );
    expect(report.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, estimated: false });
    expect(report.usage.cost?.total).toBeCloseTo((200 / 1e6) * 0.2 + (40 / 1e6) * 1, 12);
  });

  it("falls back to the estimate, and says so, when one case counted nothing", () => {
    const report = scored(lines, [
      answered({ is_urgent: noul(0.9) }, usage),
      answered({ is_urgent: noul(0.9) }),
    ]);
    expect(report.usage.estimated).toBe(true);
    expect(report.usage.inputTokens).toBeGreaterThan(0);
    expect(report.usage.cost).toBeUndefined();
  });
});

describe("the accuracy bar", () => {
  it("names the questions under it, with what they scored", () => {
    const report = scored(
      [
        '{"state": "one", "expect": {"is_urgent": true, "frustration": 2}}',
        '{"state": "two", "expect": {"is_urgent": true, "frustration": 2}}',
      ],
      [
        answered({ is_urgent: noul(0.9), frustration: score(0, 0.5) }),
        answered({ is_urgent: noul(0.9), frustration: score(2, 0.5) }),
      ],
    );
    expect(evaluate.belowBar(report, 0.8)).toEqual([["frustration", 0.5]]);
    expect(evaluate.belowBar(report, 0.4)).toEqual([]);
  });
});
