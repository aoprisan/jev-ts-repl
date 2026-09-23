/** The REPL driven without a terminal: commands in, transcript and session out. */

import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { App } from "../src/repl/app.js";
import { Builder } from "../src/repl/builder.js";
import * as codegen from "../src/repl/codegen.js";
import * as highlight from "../src/repl/highlight.js";
import { LESSONS } from "../src/repl/lessons.js";
import * as mock from "../src/repl/mock.js";
import { PRESETS } from "../src/repl/presets.js";
import { fromBody, parseChoice, parseNoul, parseScore, parseTurn } from "../src/repl/session.js";
import { parse as parsePage, render as sketchRender } from "../src/repl/sketch.js";
import { render } from "../src/repl/ui.js";
import * as wrap from "../src/repl/wrap.js";
import { Buffer } from "../src/tui/buffer.js";
import { char, ctrl, key } from "../src/tui/keys.js";
import { line, linesText } from "../src/tui/style.js";
import type { Json } from "../src/json.js";
import { raw } from "../src/typesafe/questions.js";

/**
 * Tests never talk to the API: without a key the app starts in mock mode, and with one in the
 * environment we force mock so the suite stays offline either way.
 */
function app(): App {
  const a = new App();
  a.mock = true;
  return a;
}

function transcript(a: App): string {
  return linesText(a.transcript);
}

function screen(a: App, width: number, height: number): string {
  const buffer = new Buffer(width, height);
  render(buffer, a);
  return buffer.toString();
}

function type(a: App, text: string): void {
  for (const c of text) a.handle({ kind: "key", event: char(c) });
}

describe("commands", () => {
  it("makes bare text the state", () => {
    const a = app();
    a.exec("The payout failed again, this is the third time.");
    expect(a.session.state).toBe("The payout failed again, this is the third time.");
    expect(a.session.stateIsEmpty()).toBe(false);
  });

  it("builds a full session from a preset", () => {
    const a = app();
    a.exec(":preset triage");
    expect(a.session.questions.map(([n]) => n)).toEqual(["department", "frustration", "is_urgent"]);

    const body = JSON.parse(a.session.requestJson("jev-latest")) as Record<string, Json>;
    const questions = body["questions"] as Record<string, Record<string, Json>>;
    expect(questions["department"]?.["type"]).toBe("choice");
    expect(questions["frustration"]?.["type"]).toBe("score");
    expect(questions["is_urgent"]?.["type"]).toBe("noul");
    expect(body["model"]).toBe("jev-latest");
    expect((questions["frustration"]?.["criteria"] as Json[]).length).toBe(3);
  });

  it("parses criteria out of the question commands", () => {
    const noul = parseNoul("is_urgent Conveys urgency | yes: A deadline | no: Routine");
    expect(noul.ok).toBe(true);
    if (!noul.ok) return;
    const [name, question] = noul.value;
    expect(name).toBe("is_urgent");
    expect(question.kind).toBe("noul");
    expect(question.kind === "noul" && question.criteria?.yes).toBe("A deadline");
    expect(question.kind === "noul" && question.criteria?.no).toBe("Routine");

    const choice = parseChoice("dept Which team | billing=Payments | tech");
    expect(choice.ok).toBe(true);
    if (choice.ok) {
      const q = choice.value[1];
      expect(q.kind === "choice" && q.options).toEqual([
        ["billing", "Payments"],
        ["tech", null],
      ]);
    }

    // Structured instructions stay JSON rather than becoming a string.
    const score = parseScore('tone {"task": "rate"} | low | high');
    expect(score.ok).toBe(true);
    if (score.ok) {
      const q = score.value[1];
      expect(q.kind === "score" && (q.instructions as Record<string, Json>)["task"]).toBe("rate");
    }

    expect(parseChoice("dept Which team | only_one").ok).toBe(false);
    expect(parseScore("tone Rate it | just_one").ok).toBe(false);
    expect(parseNoul("nameonly").ok).toBe(false);
  });

  it("answers every question in mock mode", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":ask");

    const raw = JSON.parse(a.lastRaw ?? "") as Record<string, Json>;
    const answers = raw["answers"] as Record<string, Record<string, Json>>;
    expect(Object.keys(answers)).toHaveLength(3);
    const p = answers["is_urgent"]?.["noul"] as number;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
    const probabilities = answers["department"]?.["probabilities"] as Record<string, number>;
    const sum = Object.values(probabilities).reduce((x, y) => x + y, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-6);

    const text = transcript(a);
    expect(text).toContain("answers");
    expect(text).toContain("department");
  });

  it("simulates the same numbers every time", () => {
    const state = "a ticket about billing";
    const question = { type: "noul", instructions: "urgent?" };
    expect(mock.answer(state, "urgent", question)).toEqual(mock.answer(state, "urgent", question));
    expect(mock.answer(state, "x", { type: "mystery" })).toBeUndefined();

    // Pinned, because the Rust port simulates from the same FNV-1a seed and the two are meant to
    // answer a page identically. The same vectors are asserted there.
    expect(mock.answer(state, "urgent", question)).toEqual({ type: "noul", noul: 0.742 });
    expect(
      mock.answer(state, "team", {
        type: "choice",
        instructions: "which team",
        criteria: { billing: "money", technical: "bugs" },
      }),
    ).toEqual({
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.599, technical: 0.401 },
      confidence: 0.198,
    });
  });

  it("refuses to send a session with no questions", () => {
    const a = app();
    a.exec("some state");
    a.exec(":ask");
    expect(a.lastRaw).toBeUndefined();
    expect(transcript(a)).toContain("no questions yet");
  });

  it("changes what counts as a yes", () => {
    const a = app();
    a.exec(":threshold 0.9");
    expect(a.threshold).toBe(0.9);
    a.exec(":threshold 4");
    expect(a.threshold).toBe(0.9);
  });

  it("round-trips a saved session", () => {
    const a = app();
    a.exec(":preset moderation");
    const body = a.session.requestJson("jev-latest");
    const reopened = fromBody(body);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.questions).toHaveLength(a.session.questions.length);
    expect(reopened.value.requestJson("jev-latest")).toBe(a.session.requestJson("jev-latest"));
  });

  it("warns about an unknown command", () => {
    const a = app();
    a.exec(":nope");
    expect(transcript(a)).toContain("unknown command :nope");
  });

  it("loads every preset and answers it", () => {
    for (const preset of PRESETS) {
      const a = app();
      a.exec(`:preset ${preset.name}`);
      expect(a.session.questions.length).toBeGreaterThanOrEqual(3);
      expect(a.session.stateIsEmpty()).toBe(false);
      a.exec(":ask");
      expect(a.lastRaw, `preset ${preset.name} produced no answers`).toBeDefined();
    }
  });

  it("accepts every command the lessons suggest", () => {
    for (const lesson of LESSONS) {
      const a = app();
      a.exec(":preset triage"); // so :ask-style suggestions have something to work with
      a.exec(lesson.tryThis);
      expect(transcript(a), `lesson ${lesson.title}`).not.toContain("unknown command");
    }
  });
});

describe("generated code", () => {
  it("reflects the session in TypeScript", () => {
    const a = app();
    a.exec(":preset triage");
    const code = codegen.typescript(a.session, "jev-2", 0.8);
    expect(code).toContain('import { Client, choice, noul, rubric, score } from "jev-repl";');
    expect(code).toContain("const questions = rubric({");
    expect(code).toContain("const { answers } = await client.ask(");
    expect(code).toContain('department: choice("Which team should handle this", {');
    expect(code).toContain('billing: "Payment or subscription issues",');
    expect(code).toContain('frustration: score("How frustrated the customer appears", [');
    expect(code).toContain('{ model: "jev-2" }');
    expect(code).toContain("is_urgent.noul >= 0.80");
    expect(code).toContain("const department = answers.department;");
  });

  it("reflects the session in Rust", () => {
    const a = app();
    a.exec(":preset triage");
    const code = codegen.rust(a.session, "jev-2", 0.8);
    expect(code).toContain("use typesafe::{Choice, Client, Noul, Questions, Score};");
    expect(code).toContain('.with("department", Choice::new(');
    expect(code).toContain('.option("billing"');
    expect(code).toContain("Score::new(");
    expect(code).toContain('.model("jev-2")');
    expect(code).toContain("is_yes(0.80)");
    expect(code, "no json! is needed for plain text").not.toContain("json!(");
  });

  it("gates on the page's own bars instead of the hard-coded ones", () => {
    const a = app();
    a.exec(":preset triage");
    const plain = codegen.typescript(a.session, "jev-2", 0.5);
    expect(plain).toContain("department.confidence >= 0.6)");
    expect(plain).not.toContain("frustration.confidence >= ");
    a.session.bars.set("is_urgent", 0.625);
    a.session.bars.set("department", 0.75);
    a.session.bars.set("frustration", 1);
    const ts = codegen.typescript(a.session, "jev-2", 0.5);
    expect(ts).toContain("is_urgent.noul >= 0.625");
    expect(ts).toContain("if (department.confidence >= 0.75) {");
    expect(ts).toContain("if (frustration.confidence >= 1) {");
    expect(ts).toContain(
      "console.log(`frustration: unsure (${frustration.confidence.toFixed(2)}), send to a human`);",
    );
    const rust = codegen.rust(a.session, "jev-2", 0.5);
    expect(rust).toContain("is_yes(0.625)");
    expect(rust).toContain("if department.confidence >= 0.75 {");
    expect(rust).toContain("if frustration.confidence >= 1.0 {");
    a.session.bars.set("is_urgent", 0.7);
    expect(codegen.typescript(a.session, "jev-2", 0.5)).toContain("is_urgent.noul >= 0.70");
    expect(codegen.rust(a.session, "jev-2", 0.5)).toContain("is_yes(0.70)");
  });

  it("writes TypeScript that type-checks against this package", () => {
    const a = app();
    a.exec(":preset triage");
    a.session.bars.set("frustration", 0.7);
    a.session.questions.push(["needs-review", raw({ type: "noul", instructions: "Escalate?" })]);
    const code = codegen.typescript(a.session, "jev-2", 0.8);
    expect(code).toContain('answers["needs-review"]');
    // The program as a user would save it, importing this checkout instead of the package.
    const file = join(dirname(fileURLToPath(import.meta.url)), `.generated-${process.pid}.ts`);
    writeFileSync(file, `${code.replace('from "jev-repl"', 'from "../src/index.js"')}export {};\n`);
    try {
      const { config } = ts.readConfigFile("tsconfig.json", (f) => ts.sys.readFile(f));
      const { options } = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd());
      const program = ts.createProgram([file], { ...options, noEmit: true });
      const problems = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === file)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      expect(problems).toEqual([]);
    } finally {
      rmSync(file, { force: true });
    }
  }, 30_000);

  it("says what to do when there is nothing to generate", () => {
    const a = app();
    expect(codegen.typescript(a.session, "jev-latest", 0.5)).toContain(
      "// add questions in the REPL",
    );
  });
});

describe("the input line", () => {
  it("crosses and deletes words with Alt-arrow", () => {
    const a = app();
    for (const c of ":noul is_urgent conveys urgency") {
      a.handle({ kind: "key", event: char(c) });
    }
    expect(a.cursor).toBe(31);
    a.handle({ kind: "key", event: key({ kind: "left" }, { alt: true }) });
    expect(a.cursor).toBe(24);
    a.handle({ kind: "key", event: key({ kind: "left" }, { ctrl: true }) });
    expect(a.cursor, "Ctrl-← is the other spelling of the same key").toBe(16);
    a.handle({ kind: "key", event: char("f", { alt: true }) });
    expect(a.cursor).toBe(23);
    a.handle({ kind: "key", event: key({ kind: "backspace" }, { alt: true }) });
    expect(a.input).toBe(":noul is_urgent  urgency");
  });
});

describe("builder mode", () => {
  const press = (b: Builder, event: Parameters<Builder["key"]>[0]): void => {
    b.key(event);
  };
  const typeInto = (b: Builder, text: string): void => {
    for (const c of text) press(b, char(c));
  };

  /** Fill the app's open builder in as a two-option choice and add it. */
  const buildChoice = (a: App, name: string, pickChoice = false): void => {
    const send = (event: Parameters<Builder["key"]>[0]): void => {
      a.handle({ kind: "key", event });
    };
    if (!a.builder) throw new Error("the builder is not open");
    for (const c of name) send(char(c));
    send(key({ kind: "tab" })); // type
    if (pickChoice) send(char("c"));
    send(key({ kind: "tab" })); // instructions
    for (const c of "Which team") send(char(c));
    send(key({ kind: "tab" }));
    for (const c of "billing") send(char(c));
    send(key({ kind: "tab" }));
    send(key({ kind: "tab" }));
    for (const c of "technical") send(char(c));
    send(ctrl("s"));
  };

  it("produces the same question as the command", () => {
    // A name was given, so the form opens on the type field.
    const b = new Builder("", "department");
    press(b, char("c")); // noul → choice
    press(b, key({ kind: "tab" }));
    typeInto(b, "Which team should handle this");
    press(b, key({ kind: "tab" }));
    typeInto(b, "billing");
    press(b, key({ kind: "tab" }));
    typeInto(b, "Payment or subscription issues");
    press(b, key({ kind: "tab" }));
    typeInto(b, "technical");

    expect(b.asCommand()).toBe(
      ":choice department Which team should handle this | billing=Payment or subscription issues | technical",
    );
    const preview = b.preview() as Record<string, Record<string, Record<string, Json>>>;
    expect(preview["department"]?.["type"]).toBe("choice");
    expect(preview["department"]?.["criteria"]?.["billing"]).toBe("Payment or subscription issues");

    const outcome = b.key(ctrl("s"));
    expect(outcome.kind).toBe("commit");
    if (outcome.kind !== "commit") return;
    expect(outcome.name).toBe("department");
    expect(outcome.question.kind === "choice" && outcome.question.options).toEqual([
      ["billing", "Payment or subscription issues"],
      ["technical", null],
    ]);
  });

  it("refuses an incomplete question", () => {
    const empty = new Builder("", "");
    expect(empty.key(ctrl("s")).kind).toBe("open");
    expect(empty.message).toContain("name");

    const b = new Builder("", "tone");
    press(b, char("s")); // score
    press(b, key({ kind: "tab" }));
    typeInto(b, "How warm the reply is");
    expect(b.key(ctrl("s")).kind).toBe("open");
    expect(b.message).toContain("two ordered levels");
  });

  it("keeps the type for the next question of the same shape", () => {
    const a = app();
    a.exec(":state A ticket");
    a.handle({ kind: "key", event: ctrl("b") });
    expect(a.builder?.kind, "a fresh builder opens on a noul").toBe("noul");

    buildChoice(a, "department", true);
    expect(a.session.questions.map(([name]) => name)).toEqual(["department"]);
    // The form stays open on `choice`, so a second choice costs no keystrokes.
    expect(a.builder?.kind).toBe("choice");
    expect(a.builder?.existing).toEqual(["department"]);
    expect(transcript(a)).toContain("type still `choice`");

    buildChoice(a, "owner");
    expect(a.session.questions.map(([name, q]) => `${name}:${q.kind}`)).toEqual([
      "department:choice",
      "owner:choice",
    ]);
  });

  it("asks before a new question replaces one of the same name", () => {
    const b = new Builder("A ticket", "", { kind: "choice", existing: ["department"] });
    expect(b.kind, "the type it opens on is the one just used").toBe("choice");
    typeInto(b, "department");
    press(b, key({ kind: "tab" })); // type
    press(b, key({ kind: "tab" })); // instructions
    typeInto(b, "Which team");
    press(b, key({ kind: "tab" }));
    typeInto(b, "billing");
    press(b, key({ kind: "tab" }));
    press(b, key({ kind: "tab" }));
    typeInto(b, "technical");

    expect(b.key(ctrl("s")).kind).toBe("open");
    expect(b.message).toContain("already a question");
    // Saying it again means it: the session's `insert` does the replacing.
    expect(b.key(ctrl("s")).kind).toBe("commit");

    // Renaming disarms the warning, so the next one is added rather than replaced.
    const c = new Builder("A ticket", "", { kind: "noul", existing: ["is_urgent"] });
    typeInto(c, "is_urgent");
    press(c, key({ kind: "tab" }));
    press(c, key({ kind: "tab" }));
    typeInto(c, "Conveys urgency");
    expect(c.key(ctrl("s")).kind).toBe("open");
    press(c, key({ kind: "up" })); // back to the name
    press(c, key({ kind: "up" }));
    typeInto(c, "_too");
    const outcome = c.key(ctrl("s"));
    expect(outcome.kind === "commit" && outcome.name).toBe("is_urgent_too");
  });

  it("crosses a word with Alt-arrow", () => {
    const b = new Builder("the payout failed again", "");
    expect(b.focused().kind).toBe("name");
    press(b, key({ kind: "up" })); // onto the state field, cursor at its end
    expect(b.cursor).toBe(23);
    press(b, key({ kind: "left" }, { alt: true }));
    expect(b.cursor).toBe(18);
    press(b, char("f", { alt: true }));
    expect(b.cursor).toBe(23);
    // The type row keeps ← → for switching the type.
    const typed = new Builder("", "tone");
    expect(typed.focused().kind).toBe("type");
    press(typed, key({ kind: "left" }, { alt: true }));
    expect(typed.kind).toBe("score");
  });

  it("adds and drops rows", () => {
    const b = new Builder("", "tone");
    press(b, char("s")); // score
    const before = b.fields().length;
    b.addRow();
    expect(b.fields()).toHaveLength(before + 1);
    // Rows only vanish under the cursor, so step onto one first.
    press(b, key({ kind: "tab" })); // instructions
    press(b, key({ kind: "tab" })); // level 0
    b.deleteRow();
    expect(b.fields()).toHaveLength(before);
  });
});

describe("highlighting and wrapping", () => {
  it("separates JSON keys from values", () => {
    const spans = highlight
      .jsonSpans('  "model": "jev-latest",')
      .filter((s) => s.text.trim() !== "");
    expect(spans[0]?.text).toBe('"model"');
    expect(spans[2]?.text).toBe('"jev-latest"');
    expect(spans[0]?.style.fg, "a key is not styled as a string").not.toBe(spans[2]?.style.fg);
  });

  it("flags unknown commands", () => {
    const known = (c: string): boolean => c === ":choice";
    const good = highlight.command(":choice dept Pick | a=1 | b=2", known);
    expect(good[0]?.text).toBe(":choice");
    const bad = highlight.command(":nope x", known);
    expect(bad[0]?.style.fg).not.toBe(good[0]?.style.fg);
  });

  it("wraps long lines to the pane", () => {
    const wrapped = wrap.wrap(line("word ".repeat(40)), 20);
    expect(wrapped.length).toBeGreaterThan(1);
    for (const l of wrapped) {
      const width = l.spans.reduce((n, s) => n + [...s.text].length, 0);
      expect(width, `line of ${width} columns in a 20-column pane`).toBeLessThanOrEqual(20);
    }
  });
});

describe("the screen", () => {
  it("renders the whole thing", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":ask");
    const drawn = screen(a, 120, 40);
    expect(drawn).toContain("jev");
    expect(drawn).toContain("MOCK");
    expect(drawn).toContain("department");

    // …and again with builder mode open over it.
    a.exec(":build sentiment");
    const withBuilder = screen(a, 120, 40);
    expect(withBuilder).toContain("build a question");
    expect(withBuilder).toContain("sentiment");
  });

  it("draws in a tiny terminal without throwing", () => {
    const a = app();
    a.exec(":preset triage");
    expect(() => screen(a, 30, 6)).not.toThrow();
    expect(() => screen(a, 4, 2)).not.toThrow();
  });
});

describe("secrets", () => {
  it("never echoes or remembers an API key", () => {
    const a = app();
    // Typed at the prompt, the way a user would.
    type(a, ":key sk-not-a-real-key");
    a.handle({ kind: "key", event: key({ kind: "enter" }) });
    const text = transcript(a);
    expect(text).not.toContain("sk-not-a-real-key");
    expect(text, "the tail is enough to tell keys apart").toContain("…-key");
    expect(a.history).not.toContain(":key sk-not-a-real-key");
  });
});

describe("a conversation as the state", () => {
  it("grows the state one turn at a time", () => {
    const a = app();
    a.exec(":turn customer: The payout failed again.");
    a.exec(":turn agent: Can you confirm the last four digits?");
    expect(a.session.state).toEqual([
      { who: "customer", said: "The payout failed again." },
      { who: "agent", said: "Can you confirm the last four digits?" },
    ]);
    expect(a.session.turns()?.length).toBe(2);
  });

  it("names the speaker only when the first word ends in a colon", () => {
    expect(parseTurn("customer: I want a refund")).toEqual({
      ok: true,
      value: { who: "customer", said: "I want a refund" },
    });
    expect(parseTurn("I want a refund now")).toEqual({
      ok: true,
      value: { said: "I want a refund now" },
    });
    expect(parseTurn("customer:")).toMatchObject({ ok: false });
    expect(parseTurn("   ")).toMatchObject({ ok: false });
  });

  it("makes the text already in the state the first turn", () => {
    const a = app();
    a.exec("The payout failed again.");
    a.exec(":turn agent: We are looking into it.");
    expect(a.session.state).toEqual([
      { said: "The payout failed again." },
      { who: "agent", said: "We are looking into it." },
    ]);
    expect(transcript(a)).toContain("the state you had became the first turn");
  });

  it("refuses to reshape a state that is not a conversation", () => {
    const a = app();
    a.exec(':state json {"ticket": 1}');
    a.exec(":turn agent: We are looking into it.");
    expect(a.session.state).toEqual({ ticket: 1 });
    expect(transcript(a)).toContain("not a conversation");
  });

  it("takes the last turn back, and the last one of all empties the state", () => {
    const a = app();
    a.exec(":turn customer: The payout failed again.");
    a.exec(":turn agent: We are looking into it.");
    a.exec(":turn drop");
    expect(a.session.turns()).toEqual([{ who: "customer", said: "The payout failed again." }]);
    a.exec(":turn drop");
    expect(a.session.stateIsEmpty()).toBe(true);
    a.exec(":turn drop");
    expect(transcript(a)).toContain("no turns to drop");
  });

  it("reads a transcript written with the keys a chat API uses", () => {
    const a = app();
    a.exec(':state json [{"role": "user", "content": "Refund me"}]');
    expect(a.session.turns()).toEqual([{ who: "user", said: "Refund me" }]);
    a.exec(":turn agent: Looking into it.");
    expect(a.session.turns()?.length).toBe(2);
  });

  it("keeps the questions fixed, so the same rubric reads the whole thread", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":state clear");
    const before = a.session.questions.map(([n]) => n);
    a.exec(":turn customer: The payout failed again.");
    a.exec(":turn customer: I want a refund now.");
    expect(a.session.questions.map(([n]) => n)).toEqual(before);
    const body = JSON.parse(a.session.requestJson("jev-latest")) as Record<string, Json>;
    expect(Array.isArray(body["state"])).toBe(true);
    expect(Object.keys(body["questions"] as object)).toEqual(before);
  });

  it("lists the turns instead of raw JSON when the state is asked for", () => {
    const a = app();
    a.exec(":turn customer: The payout failed again.");
    a.transcript = [];
    a.exec(":state");
    expect(transcript(a)).toContain("conversation (1 turn)");
    expect(transcript(a)).toContain("The payout failed again.");
  });

  it("survives a round trip through a sketch page", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":turn agent: Have you tried another browser?");
    const page = sketchRender(a.session);
    const back = parsePage(page).toSession();
    expect(back.turns()).toEqual(a.session.turns());
  });

  it("counts the turns in the panel preview", () => {
    const a = app();
    a.exec(":turn customer: The payout failed again.");
    a.exec(":turn agent: Looking into it.");
    expect(a.session.statePreview()).toBe("2 turns · agent: Looking into it.");
  });
});
