/** Following a rubric across a conversation: the prefixes, the series and the lines. */

import { describe, expect, it } from "vitest";

import { App } from "../src/repl/app.js";
import type { Answered } from "../src/repl/headless.js";
import * as headless from "../src/repl/headless.js";
import { Session } from "../src/repl/session.js";
import * as trend from "../src/repl/trend.js";
import { linesText } from "../src/tui/style.js";
import type { Answer } from "../src/typesafe/responses.js";

const PAGE = `[{"who": "customer", "said": "Hi"}, {"who": "agent", "said": "Hello"}, {"role": "user", "content": "It is down and we lose money"}]
---
is_urgent? The message conveys urgency
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
frustration: How frustrated the customer appears
  Calm < Annoyed < Furious
`;

function session(): Session {
  const loaded = headless.load(PAGE);
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

const noul = (p: number): Answer => ({ type: "noul", noul: p });
const choice = (label: string, probabilities: Record<string, number>): Answer => ({
  type: "choice",
  choice: label,
  probabilities,
  confidence: 0.5,
});
const score = (value: number): Answer => ({
  type: "score",
  score: value,
  confidence: 0.5,
  legend: new Map([
    [0, "Calm"],
    [1, "Annoyed"],
    [2, "Furious"],
  ]),
  probabilities: new Map(),
});

const PER_TURN: Answered[][] = [
  [
    ["is_urgent", noul(0.12)],
    ["department", choice("billing", { billing: 0.6, technical: 0.35 })],
    ["frustration", score(0.2)],
  ],
  [
    ["is_urgent", noul(0.4)],
    ["department", choice("technical", { billing: 0.45, technical: 0.55 })],
    ["frustration", score(0.4)],
  ],
  [
    ["is_urgent", noul(0.91)],
    ["department", choice("technical", { billing: 0.2, technical: 0.8 })],
    ["frustration", score(1.7)],
  ],
];

describe("the prefixes", () => {
  it("asks after every turn, the way the cost table prices the thread", () => {
    const steps = trend.prefixes(session());
    expect(steps.map((s) => s.state)).toEqual([
      [{ who: "customer", said: "Hi" }],
      [
        { who: "customer", said: "Hi" },
        { who: "agent", said: "Hello" },
      ],
      [
        { who: "customer", said: "Hi" },
        { who: "agent", said: "Hello" },
        { who: "user", said: "It is down and we lose money" },
      ],
    ]);
    expect(steps[0]?.questions).toHaveLength(3);
    const plain = session();
    plain.state = "not a thread";
    expect(trend.prefixes(plain)).toEqual([]);
  });
});

describe("the series", () => {
  const all = trend.series(session(), PER_TURN, 0.5);

  it("follows a noul's probability and reads it at the threshold", () => {
    expect(all[0]).toEqual({
      name: "is_urgent",
      kind: "noul",
      values: [0.12, 0.4, 0.91],
      top: 1,
      readings: ["no", "no", "yes"],
    });
    const barred = session();
    barred.bars.set("is_urgent", 0.3);
    expect(trend.series(barred, PER_TURN, 0.5)[0]?.readings).toEqual(["no", "yes", "yes"]);
  });

  it("follows the label a choice ended on, and names the leader at every turn", () => {
    expect(all[1]).toMatchObject({
      values: [0.35, 0.55, 0.8],
      label: "technical",
      readings: ["billing", "technical", "technical"],
    });
  });

  it("follows a score's weighted level against its scale", () => {
    expect(all[2]).toMatchObject({ values: [0.2, 0.4, 1.7], top: 2 });
    expect(all[2]?.readings).toEqual(["level 0", "level 0", "level 2"]);
  });

  it("has nothing to follow when a turn came back without the answer", () => {
    const gappy = PER_TURN.map((turn, i) => (i === 1 ? turn.slice(1) : turn));
    expect(trend.series(session(), gappy, 0.5)[0]?.values).toEqual([]);
  });
});

describe("drawing it", () => {
  it("scales the spark to a fixed top, not to the values", () => {
    expect(trend.sparkline([0, 0.5, 1], 1)).toBe("▁▅█");
    expect(trend.sparkline([0.9, 0.9], 1)).toBe("▇▇");
    expect(trend.sparkline([0, 1, 2], 2)).toBe("▁▅█");
    expect(trend.sparkline([-1, 3], 2)).toBe("▁█");
  });

  it("lists the turns it changed its mind, or says it never did", () => {
    expect(trend.changes(["no", "no", "yes", "no"])).toBe("turn 3 yes · turn 4 no");
    expect(trend.changes(["no", "no"])).toBe("no throughout");
  });

  it("draws one line per question", () => {
    const text = linesText(trend.trendLines(trend.series(session(), PER_TURN, 0.5)));
    expect(text.split("\n")).toEqual([
      "  is_urgent    noul    ▂▄▇  0.12 → 0.91            turn 3 yes",
      "  department   choice  ▃▅▇  technical 0.35 → 0.80  turn 2 technical",
      "  frustration  score   ▂▂▇  0.20 → 1.70 of 2       turn 3 level 2",
    ]);
    const missing = trend.trendLines([
      { name: "tone", kind: "raw", values: [], top: 1, readings: [] },
    ]);
    expect(linesText(missing)).toBe("  tone  raw     no answer to follow");
  });
});

describe(":trend in the REPL", () => {
  function app(): App {
    const a = new App();
    a.mock = true;
    return a;
  }

  it("asks after every turn and prices every call", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":turn agent: Sorry — can you confirm the last four digits?");
    a.exec(":turn customer: I sent them twice already. I want a refund now.");
    a.exec(":cost 0.20/1.00");
    a.exec(":trend");
    const text = linesText(a.transcript);
    expect(text).toContain("trend · 3 turns");
    expect(text).toMatch(/is_urgent\s+noul\s+[▁▂▃▄▅▆▇█]{3}\s+\d\.\d\d → \d\.\d\d/);
    expect(text).toMatch(/department\s+choice\s+[▁▂▃▄▅▆▇█]{3}\s+\w+ \d\.\d\d → \d\.\d\d/);
    expect(text).toMatch(/frustration\s+score\s+[▁▂▃▄▅▆▇█]{3}\s+\d\.\d\d → \d\.\d\d of 2/);
    expect(text).toMatch(
      /≈ \d+ in \/ \d+ out tokens · \$\d+\.\d+ over 3 calls — estimated, since nothing was sent\./,
    );
  });

  it("says what it needs when there is no conversation to follow", () => {
    const a = app();
    a.exec(":trend");
    expect(linesText(a.transcript)).toContain("no questions yet");
    a.exec(":preset triage");
    a.exec(":trend");
    expect(linesText(a.transcript)).toContain(
      ":trend needs a conversation — `:turn <who>: <text>` builds one, a turn at a time.",
    );
  });

  it("is listed in :help", () => {
    const a = app();
    a.exec(":help");
    expect(linesText(a.transcript)).toContain(":trend");
  });
});
