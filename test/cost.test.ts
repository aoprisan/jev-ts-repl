/** What a call is expected to cost: the token estimate, the rates, and the `:cost` command. */

import { describe, expect, it } from "vitest";

import { App } from "../src/repl/app.js";
import * as cost from "../src/repl/cost.js";
import { Editor } from "../src/repl/editor.js";
import { costLines } from "../src/repl/format.js";
import { render } from "../src/repl/ui.js";
import { Buffer } from "../src/tui/buffer.js";
import { ctrl } from "../src/tui/keys.js";
import { linesText } from "../src/tui/style.js";

function app(): App {
  const a = new App();
  a.mock = true;
  a.rates = undefined;
  return a;
}

function transcript(a: App): string {
  return linesText(a.transcript);
}

describe("token estimates", () => {
  it("counts prose at about four characters a token", () => {
    const text = "The payout failed again, third time this month.";
    const tokens = cost.estimateTokens(text);
    expect(tokens).toBeGreaterThan(text.length / 8);
    expect(tokens).toBeLessThan(text.length / 2);
  });

  it("charges nothing for whitespace and nothing for an empty string", () => {
    expect(cost.estimateTokens("")).toBe(0);
    expect(cost.estimateTokens("   \n\t ")).toBe(0);
    expect(cost.estimateTokens("payout failed")).toBe(cost.estimateTokens("payout     failed"));
  });

  it("grows with the text", () => {
    const one = cost.estimateTokens("The payout failed.");
    const two = cost.estimateTokens("The payout failed. The payout failed.");
    expect(two).toBeGreaterThan(one);
  });

  it("counts a CJK character as a token of its own", () => {
    expect(cost.estimateTokens("支払いが失敗")).toBe(6);
  });

  it("reads JSON punctuation as tokens, not as free characters", () => {
    expect(cost.estimateJsonTokens({ type: "noul", instructions: "Urgent?" })).toBeGreaterThan(5);
  });
});

describe("what a session costs", () => {
  it("splits the request between state, questions and envelope", () => {
    const a = app();
    a.exec(":preset triage");
    const estimate = cost.estimate(a.session, "jev-latest");

    const questions = estimate.questions.reduce((sum, q) => sum + q.inputTokens, 0);
    expect(estimate.inputTokens).toBe(estimate.stateTokens + estimate.envelopeTokens + questions);
    const answers = estimate.questions.reduce((sum, q) => sum + q.outputTokens, 0);
    expect(estimate.outputTokens).toBe(estimate.answerEnvelopeTokens + answers);
    expect(estimate.questions.map((q) => q.name)).toEqual([
      "department",
      "frustration",
      "is_urgent",
    ]);
    expect(estimate.questions.map((q) => q.kind)).toEqual(["choice", "score", "noul"]);
  });

  it("prices the answer each question asks for: more labels, more to answer", () => {
    const small = app();
    small.exec(":choice department Which team | billing=Payments | technical=Bugs");
    const big = app();
    big.exec(
      ":choice department Which team | billing=Payments | technical=Bugs | sales=Pricing | legal=Contracts",
    );
    const smallOut = cost.estimate(small.session, "jev-latest").outputTokens;
    const bigOut = cost.estimate(big.session, "jev-latest").outputTokens;
    expect(bigOut).toBeGreaterThan(smallOut);
  });

  it("charges a noul less than a score that echoes its legend", () => {
    const a = app();
    a.exec(":noul is_urgent The message conveys urgency");
    a.exec(":score frustration How frustrated | Calm | Annoyed | Furious");
    const estimate = cost.estimate(a.session, "jev-latest");
    const noul = estimate.questions.find((q) => q.name === "is_urgent");
    const score = estimate.questions.find((q) => q.name === "frustration");
    expect(noul?.outputTokens).toBeLessThan(score?.outputTokens ?? 0);
    expect(noul?.assumed).toBe(false);
  });

  it("assumes an answer for a question shape it cannot model", () => {
    const a = app();
    a.exec(':raw tone {"type": "tone", "instructions": "Polite?"}');
    const estimate = cost.estimate(a.session, "jev-latest");
    expect(estimate.questions[0]?.kind).toBe("tone");
    expect(estimate.questions[0]?.assumed).toBe(true);
    expect(estimate.questions[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("grows with the state", () => {
    const a = app();
    a.exec(":noul is_urgent The message conveys urgency");
    const short = cost.estimate(a.session, "jev-latest").inputTokens;
    a.exec("The payout failed again, third time this month, and nobody has replied yet.");
    expect(cost.estimate(a.session, "jev-latest").inputTokens).toBeGreaterThan(short);
  });
});

describe("rates", () => {
  it("takes a pair of dollar amounts in any of the usual separators", () => {
    for (const text of ["0.20/1.00", "0.20 1.00", "$0.20, $1.00", " 0.20 / 1.00 "]) {
      const parsed = cost.parseRates(text);
      expect(parsed.ok && parsed.value).toEqual({ input: 0.2, output: 1 });
    }
  });

  it("says what it wants when the pair is not a pair", () => {
    for (const text of ["", "0.20", "cheap/free", "1/2/3", "-1/2"]) {
      expect(cost.parseRates(text).ok).toBe(false);
    }
  });

  it("reads the environment, and ignores it when it is nonsense", () => {
    expect(cost.ratesFromEnv("0.20/1.00")).toEqual({ input: 0.2, output: 1 });
    expect(cost.ratesFromEnv(undefined)).toBeUndefined();
    expect(cost.ratesFromEnv("")).toBeUndefined();
    expect(cost.ratesFromEnv("free")).toBeUndefined();
  });

  it("round-trips through the form the environment variable takes", () => {
    const rates = { input: 0.2, output: 1 };
    expect(cost.ratesValue(rates)).toBe("0.20/1.00");
    expect(cost.ratesFromEnv(cost.ratesValue(rates))).toEqual(rates);
    expect(cost.formatRates(rates)).toBe("$0.20/$1.00 per Mtok");
  });

  it("prices tokens per million", () => {
    const priced = cost.price(1_000_000, 500_000, { input: 0.2, output: 1 });
    expect(priced.input).toBeCloseTo(0.2, 10);
    expect(priced.output).toBeCloseTo(0.5, 10);
    expect(priced.total).toBeCloseTo(0.7, 10);
  });

  it("prices what a call reported, and nothing when it reported nothing", () => {
    const rates = { input: 0.2, output: 1 };
    expect(cost.priceUsage({ inputTokens: 1_000_000, outputTokens: 0 }, rates)?.total).toBeCloseTo(
      0.2,
      10,
    );
    expect(cost.priceUsage({ inputTokens: 10 }, rates)).toBeUndefined();
    expect(cost.priceUsage({}, rates)).toBeUndefined();
  });

  it("shows small money without rounding it away", () => {
    expect(cost.usd(0)).toBe("$0");
    expect(cost.usd(0.0000002)).toBe("<$0.000001");
    expect(cost.usd(0.000232)).toBe("$0.000232");
    expect(cost.usd(0.2316)).toBe("$0.2316");
    expect(cost.usd(12.5)).toBe("$12.50");
  });
});

describe(":cost", () => {
  it("counts tokens before any rates are set", () => {
    const a = app();
    a.exec(":preset triage");
    a.transcript = [];
    a.exec(":cost");
    const text = transcript(a);
    expect(text).toContain("cost estimate");
    expect(text).toContain("department");
    expect(text).toContain("no rates set");
    expect(text).not.toContain("per 1,000 calls");
  });

  it("prices the session once rates are given, and stops when they are cleared", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":cost 0.20/1.00");
    expect(a.rates).toEqual({ input: 0.2, output: 1 });
    expect(transcript(a)).toContain("per 1,000 calls");
    expect(transcript(a)).toContain("JEV_PRICE=0.20/1.00");

    a.transcript = [];
    a.exec(":cost off");
    expect(a.rates).toBeUndefined();
    expect(transcript(a)).toContain("rates cleared");
  });

  it("refuses a rate pair it cannot read, and keeps the rates it had", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":cost 0.20/1.00");
    a.transcript = [];
    a.exec(":cost gratis");
    expect(a.rates).toEqual({ input: 0.2, output: 1 });
    expect(transcript(a)).toContain("dollars per million tokens");
  });

  it("starts with the rates the environment sets", () => {
    const before = process.env[cost.PRICE_ENV];
    try {
      process.env[cost.PRICE_ENV] = "0.30/1.20";
      expect(new App().rates).toEqual({ input: 0.3, output: 1.2 });
      process.env[cost.PRICE_ENV] = "gratis";
      expect(new App().rates).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env[cost.PRICE_ENV];
      else process.env[cost.PRICE_ENV] = before;
    }
  });

  it("says there is nothing to price on an empty session", () => {
    const a = app();
    a.transcript = [];
    a.exec(":cost");
    expect(transcript(a)).toContain("nothing to price yet");
  });

  it("puts the estimate under simulated answers, since nothing was sent", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":cost 0.20/1.00");
    a.transcript = [];
    a.ask();
    const text = transcript(a);
    expect(text).toMatch(/≈ \d+ in \/ \d+ out tokens/);
    expect(text).toContain("estimated, since nothing was sent");
  });

  it("shows the estimate in the session panel and as a sketch preview", () => {
    const a = app();
    a.exec(":preset triage");
    const panel = new Buffer(100, 26);
    render(panel, a);
    expect(panel.toString()).toContain("cost");

    a.sketch = new Editor("A payout failed.\n---\nis_urgent? The message conveys urgency");
    a.sketch.key(ctrl("p"));
    a.sketch.key(ctrl("p"));
    a.sketch.key(ctrl("p"));
    expect(a.sketch.preview).toBe("cost");
    const screen = new Buffer(100, 26);
    render(screen, a);
    expect(screen.toString()).toContain("total");
  });
});

describe("the cost table", () => {
  it("lines up the rows and totals them", () => {
    const a = app();
    a.exec(":preset triage");
    const estimate = cost.estimate(a.session, "jev-latest");
    const text = linesText(costLines(estimate, { input: 0.2, output: 1 }));
    expect(text).toContain("state");
    expect(text).toContain("envelope");
    expect(text).toContain(String(estimate.inputTokens));
    expect(text).toContain(String(estimate.outputTokens));
    expect(text).toContain("per call");
  });
});

describe("what a conversation costs", () => {
  function thread(): App {
    const a = app();
    a.exec(":preset triage");
    a.exec(":state clear");
    a.exec(":turn customer: The payout failed again, third time this month.");
    a.exec(":turn agent: Sorry about that — can you confirm the last four digits?");
    a.exec(":turn customer: I have sent them twice already. I want a refund now.");
    return a;
  }

  it("estimates one call per turn, each over a longer state", () => {
    const a = thread();
    const estimated = cost.thread(a.session, "jev-latest");
    expect(estimated?.turns).toBe(3);
    const inputs = estimated?.calls.map((c) => c.inputTokens) ?? [];
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toBeLessThan(inputs[1] as number);
    expect(inputs[1]).toBeLessThan(inputs[2] as number);
    expect(estimated?.inputTokens).toBe(inputs.reduce((s, n) => s + n, 0));
  });

  it("costs more than the last call alone, which is the point of saying it", () => {
    const a = thread();
    const one = cost.estimate(a.session, "jev-latest");
    const whole = cost.thread(a.session, "jev-latest");
    expect(whole?.inputTokens).toBeGreaterThan(one.inputTokens);
    expect(whole?.calls[2]?.inputTokens).toBe(one.inputTokens);
  });

  it("says nothing about a state that is not a conversation", () => {
    const a = app();
    a.exec(":preset triage");
    expect(cost.thread(a.session, "jev-latest")).toBeUndefined();
  });

  it("puts the turn count and the thread total in the table", () => {
    const a = thread();
    a.rates = { input: 0.2, output: 1 };
    a.transcript = [];
    a.exec(":cost");
    const text = transcript(a);
    expect(text).toContain("3 turns");
    expect(text).toContain("asked after every turn: 3 calls");
    expect(text).toMatch(/tokens for the thread/);
  });

  it("leaves the table alone when the state is one message", () => {
    const a = app();
    a.exec(":preset triage");
    a.transcript = [];
    a.exec(":cost");
    expect(transcript(a)).not.toContain("asked after every turn");
  });
});
