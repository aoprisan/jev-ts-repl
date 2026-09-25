/** Sketch mode: a page of text in, a session out, and back again. */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Json } from "../src/json.js";
import { App } from "../src/repl/app.js";
import { Editor } from "../src/repl/editor.js";
import type { Outcome } from "../src/repl/editor.js";
import * as sketch from "../src/repl/sketch.js";
import { PRESETS } from "../src/repl/presets.js";
import { render } from "../src/repl/ui.js";
import { ScreenBuffer } from "../src/tui/buffer.js";
import { char, ctrl, key } from "../src/tui/keys.js";
import type { KeyCode } from "../src/tui/keys.js";
import { linesText } from "../src/tui/style.js";

function app(): App {
  const a = new App();
  a.mock = true;
  return a;
}

function transcript(a: App): string {
  return linesText(a.transcript);
}

function questions(parsed: sketch.ParsedSketch): Record<string, Record<string, Json>> {
  const session = parsed.toSession();
  const model = session.model ?? "jev-latest";
  const body = JSON.parse(session.requestJson(model)) as Record<string, Json>;
  return body["questions"] as Record<string, Record<string, Json>>;
}

function body(parsed: sketch.ParsedSketch): Record<string, Json> {
  const session = parsed.toSession();
  return JSON.parse(session.requestJson(session.model ?? "jev-latest")) as Record<string, Json>;
}

const PAGE = `The payout failed again, third time this month. I'm done waiting.
---
is_urgent? The message conveys urgency
  yes: A deadline or a threat to leave
  no: Routine

department: Which team should handle this
  billing = Payment or subscription issues
  - technical = Bugs or integration problems
  sales

frustration: How frustrated the customer appears
  Calm < Frustrated but civil < Very angry
`;

describe("the notation", () => {
  it("decides the question type from punctuation", () => {
    const parsed = sketch.parse(PAGE);
    expect(parsed.problems).toEqual([]);
    expect(parsed.state).toBe("The payout failed again, third time this month. I'm done waiting.");

    const q = questions(parsed);
    expect(q["is_urgent"]?.["type"]).toBe("noul");
    const urgentCriteria = q["is_urgent"]?.["criteria"] as Record<string, Json>;
    expect(urgentCriteria["true"]).toBe("A deadline or a threat to leave");
    expect(urgentCriteria["false"]).toBe("Routine");
    expect(q["department"]?.["type"]).toBe("choice");
    const dept = q["department"]?.["criteria"] as Record<string, Json>;
    expect(dept["billing"]).toBe("Payment or subscription issues");
    expect(dept["technical"]).toBe("Bugs or integration problems");
    expect(dept["sales"]).toBeNull();
    expect(q["frustration"]?.["type"]).toBe("score");
    expect(q["frustration"]?.["criteria"]).toEqual(["Calm", "Frustrated but civil", "Very angry"]);

    // Questions come out in page order, and every line has a tag for the gutter.
    expect(parsed.questions.map(([n]) => n)).toEqual(["is_urgent", "department", "frustration"]);
    expect(parsed.tags[0]).toBe("state");
    expect(parsed.tags[1]).toBe("rule");
    expect(parsed.tags[2]).toBe("noul");
    expect(parsed.tags[3]).toBe("yes");
    expect(parsed.tags[4]).toBe("no");
    expect(parsed.tags[6]).toBe("choice");
    expect(parsed.tags[7]).toBe("option");
    expect(parsed.tags[11]).toBe("score");
    expect(parsed.tags[12]).toBe("level");
  });

  it("lets the parts share the first line", () => {
    const parsed = sketch.parse(
      "text\n---\ndept: Which team | billing = Payments | tech | cheap = < $10\ntone: Rate it | low < high\nok? Fine | yes: yes | no: no\n",
    );
    expect(parsed.problems).toEqual([]);
    const q = questions(parsed);
    expect(q["dept"]?.["type"]).toBe("choice");
    const dept = q["dept"]?.["criteria"] as Record<string, Json>;
    expect(dept["billing"]).toBe("Payments");
    expect(dept["tech"]).toBeNull();
    // A `<` inside a description is just text.
    expect(dept["cheap"]).toBe("< $10");
    expect(q["tone"]?.["criteria"]).toEqual(["low", "high"]);
    expect((q["ok"]?.["criteria"] as Record<string, Json>)["true"]).toBe("yes");
  });

  it("continues levels on their own lines", () => {
    const parsed = sketch.parse(
      "text\n---\nseverity: How bad\n  Fine as written\n  < Rude but publishable\n  < Abusive, needs review\n",
    );
    expect(parsed.problems).toEqual([]);
    expect(questions(parsed)["severity"]?.["criteria"]).toEqual([
      "Fine as written",
      "Rude but publishable",
      "Abusive, needs review",
    ]);
  });

  it("supports a JSON state, raw questions and a model", () => {
    const parsed = sketch.parse(
      '{"subject": "Payouts", "messages": ["…"]}\n---\n@model jev-2\n# a comment\ntone! {"type": "noul",\n  "instructions": "Polite?"}\nrubric: {"task": "rate"} | a = 1 | b = 2\n',
    );
    expect(parsed.problems).toEqual([]);
    expect((parsed.state as Record<string, Json>)["subject"]).toBe("Payouts");
    expect(parsed.model).toBe("jev-2");
    expect(body(parsed)["model"]).toBe("jev-2");
    const q = questions(parsed);
    expect(q["tone"]?.["type"]).toBe("noul");
    expect(q["tone"]?.["instructions"]).toBe("Polite?");
    // Structured instructions stay JSON.
    expect((q["rubric"]?.["instructions"] as Record<string, Json>)["task"]).toBe("rate");
    expect(parsed.tags[2]).toBe("model");
    expect(parsed.tags[3]).toBe("comment");
    expect(parsed.tags[4]).toBe("raw");
    expect(parsed.tags[5]).toBe("json");
  });

  it("points a problem at its line and says what to do", () => {
    const cases: Array<[page: string, line: number, expected: string]> = [
      ["text\n---\nnot a question\n", 2, "not a question"],
      ["text\n---\ndept: Which team\n", 2, "add options"],
      ["text\n---\ndept: Which team\n  billing\n", 2, "one option is not a choice"],
      ["text\n---\ntone: Rate it\n  only < \n", 2, "at least two levels"],
      [
        `text\n---\nsev: How bad\n  ${Array.from({ length: 11 }, (_, i) => `l${i}`).join(" < ")}\n`,
        2,
        "at most 10 levels, this one has 11",
      ],
      [
        `text\n---\ntag: Which\n${Array.from({ length: 256 }, (_, i) => `  o${i}\n`).join("")}`,
        2,
        "at most 255 options, this one has 256",
      ],
      ["text\n---\nok? Fine\n  maybe = so\n", 3, "only takes `yes"],
      ["text\n---\nsev: How bad\n  a < b\n  maybe = so\n", 2, "are mixed"],
      ["text\n---\npick: Which\n  a = x\n  a = y\n", 4, "option `a` is listed twice"],
      ["text\n---\nx? one\nx? two\n", 3, "already named"],
      ["text\n---\nraw! not json\n", 2, "not valid JSON"],
      ['text\n---\nraw! {"no": "type"}\n', 2, "with a `type`"],
      ["text\n---\n@model\n", 2, "needs a name"],
      ["text\n---\n@speed fast\n", 2, "unknown directive"],
      ["text\n---\ndept:\n", 2, "needs instructions"],
      ["just text and no rule\n", 1, "no `---` yet"],
    ];
    for (const [page, line, expected] of cases) {
      const problem = sketch.parse(page).problems[0];
      expect(problem, `${JSON.stringify(page)} should have a problem`).toBeDefined();
      expect(problem?.line, JSON.stringify(page)).toBe(line);
      expect(problem?.message, JSON.stringify(page)).toContain(expected);
    }
    // The limits themselves are fine.
    const ten = Array.from({ length: 10 }, (_, i) => `l${i}`).join(" < ");
    const options = Array.from({ length: 255 }, (_, i) => `  o${i}\n`).join("");
    expect(
      sketch.parse(`text\n---\nsev: How bad\n  ${ten}\ntag: Which\n${options}`).problems,
    ).toEqual([]);
    // A broken question drops out; the good ones stay.
    const parsed = sketch.parse("text\n---\na? fine\nb: broken\nc? also fine\n");
    expect(parsed.questions.map(([n]) => n)).toEqual(["a", "c"]);
    expect(parsed.problems).toHaveLength(1);
  });

  it("round-trips every preset through the page", () => {
    for (const preset of PRESETS) {
      const a = app();
      a.exec(`:preset ${preset.name}`);
      a.exec(":model jev-2");
      const page = sketch.render(a.session);
      const parsed = sketch.parse(page);
      expect(parsed.problems, `preset ${preset.name}:\n${page}`).toEqual([]);
      expect(parsed.toSession().requestJson("x"), `preset ${preset.name} changed:\n${page}`).toBe(
        a.session.requestJson("x"),
      );
    }
  });

  it("quotes awkward values so they round-trip", () => {
    const a = app();
    a.exec(':state json {"rows": [1, 2]}');
    a.exec(":choice op Pick | lt=a < b | pipe=x | y");
    a.exec(':score s {"task": "rate"} | a = b | c');
    a.exec(":noul n Multi\nline");
    a.exec(':raw r {"type": "mystery", "k": [1]}');
    const page = sketch.render(a.session);
    const parsed = sketch.parse(page);
    expect(parsed.problems, page).toEqual([]);
    expect(parsed.toSession().requestJson("x"), page).toBe(a.session.requestJson("x"));
  });

  it("renders an empty session as an empty page with a rule", () => {
    const page = sketch.render(app().session);
    expect(page).toBe("\n---\n");
    const parsed = sketch.parse(page);
    expect(parsed.problems).toEqual([]);
    expect(parsed.questions).toEqual([]);
  });
});

describe("the editor", () => {
  const press = (ed: Editor, code: KeyCode): Outcome => ed.key(key(code));
  const typeText = (ed: Editor, text: string): void => {
    for (const c of text) {
      if (c === "\n") press(ed, { kind: "enter" });
      else ed.key(char(c));
    }
  };

  it("builds the questions as a page is typed", () => {
    const ed = new Editor("\n---\n");
    typeText(ed, "Refund me now or I cancel.");
    press(ed, { kind: "down" });
    press(ed, { kind: "down" });
    typeText(ed, "wants_refund? Asks for money back\n  yes: Explicit ask");
    // The indented line above passes its indentation on.
    press(ed, { kind: "enter" });
    expect(ed.lines[ed.row]).toBe("  ");
    typeText(ed, "no: Anything else");
    expect(ed.dirty).toBe(true);
    const parsed = ed.parsed();
    expect(parsed.problems, ed.text()).toEqual([]);
    expect(parsed.state).toBe("Refund me now or I cancel.");
    const q = questions(parsed)["wants_refund"]?.["criteria"] as Record<string, Json>;
    expect(q["true"]).toBe("Explicit ask");
    expect(q["false"]).toBe("Anything else");
  });

  it("cuts, pastes and moves lines", () => {
    const ed = new Editor("a\nb\nc");
    ed.key(ctrl("x"));
    expect(ed.lines).toEqual(["b", "c"]);
    press(ed, { kind: "down" });
    ed.key(ctrl("u"));
    expect(ed.lines).toEqual(["b", "a", "c"]);
    expect(ed.row, "the cursor stays below the pasted line").toBe(2);
    press(ed, { kind: "up" });
    ed.key(key({ kind: "up" }, { alt: true }));
    expect(ed.lines).toEqual(["a", "b", "c"]);
    expect(ed.row).toBe(0);
    // Backspace at column 0 joins with the line above; Delete at the end joins the next.
    press(ed, { kind: "down" });
    press(ed, { kind: "backspace" });
    expect(ed.lines).toEqual(["ab", "c"]);
    press(ed, { kind: "end" });
    press(ed, { kind: "delete" });
    expect(ed.lines).toEqual(["abc"]);
  });

  it("crosses and deletes words with Alt-arrow", () => {
    const ed = new Editor("is_urgent? conveys urgency\n---");
    press(ed, { kind: "end" });
    ed.key(key({ kind: "left" }, { alt: true }));
    expect(ed.col, "onto the start of `urgency`").toBe(19);
    ed.key(char("b", { alt: true }));
    expect(ed.col, "Alt-b is the same key in a terminal that sends it").toBe(11);
    ed.key(key({ kind: "right" }, { alt: true }));
    expect(ed.col).toBe(18);
    // At the edges it steps to the neighbouring line, the way a plain arrow does.
    ed.key(key({ kind: "left" }, { alt: true }));
    ed.key(key({ kind: "left" }, { alt: true }));
    ed.key(key({ kind: "left" }, { alt: true }));
    expect([ed.row, ed.col]).toEqual([0, 0]);
    ed.key(char("f", { alt: true }));
    expect(ed.col).toBe(10);

    press(ed, { kind: "end" });
    ed.key(key({ kind: "backspace" }, { alt: true }));
    expect(ed.lines[0]).toBe("is_urgent? conveys ");
  });

  it("asks before discarding edits, and cycles the preview", () => {
    const clean = new Editor("\n---\n");
    expect(press(clean, { kind: "esc" })).toBe("cancel");

    const ed = new Editor("\n---\n");
    typeText(ed, "x");
    expect(press(ed, { kind: "esc" })).toBe("open");
    expect(ed.message).toContain("Esc again");
    // Any other key disarms it.
    typeText(ed, "y");
    expect(press(ed, { kind: "esc" })).toBe("open");
    expect(press(ed, { kind: "esc" })).toBe("cancel");

    expect(ed.preview).toBe("json");
    ed.key(ctrl("p"));
    expect(ed.preview).toBe("answers");
    ed.key(ctrl("p"));
    expect(ed.preview).toBe("ts");
    ed.key(ctrl("p"));
    expect(ed.preview).toBe("cost");
    ed.key(ctrl("p"));
    expect(ed.preview).toBe("json");
  });
});

describe("sketch mode in the app", () => {
  const typeInto = (ed: Editor, text: string): void => {
    for (const c of text) {
      if (c === "\n") ed.key(key({ kind: "enter" }));
      else ed.key(char(c));
    }
  };

  it("replaces the session with the page, and can send it", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":sketch");
    const ed = a.sketch;
    expect(ed).toBeDefined();
    if (!ed) return;
    // Drop everything after the rule and write a different question.
    ed.lines.length = 2;
    ed.row = 1;
    ed.col = 3;
    ed.key(key({ kind: "enter" }));
    typeInto(ed, "refund? The customer wants money back");
    a.handle({ kind: "key", event: ctrl("s") });
    expect(a.sketch, "^S closes the page").toBeUndefined();
    expect(a.session.questions.map(([n]) => n)).toEqual(["refund"]);
    expect(transcript(a)).toContain("session ← 1 question");

    // ^G applies and sends in one go.
    a.exec(":sketch");
    const again = a.sketch;
    expect(again).toBeDefined();
    if (!again) return;
    again.row = again.lines.length - 1;
    again.col = 0;
    typeInto(again, "\ntone: Tone | warm < cold");
    expect(a.lastRaw).toBeUndefined();
    a.handle({ kind: "key", event: ctrl("g") });
    expect(a.sketch).toBeUndefined();
    expect(a.session.questions).toHaveLength(2);
    const raw = JSON.parse(a.lastRaw ?? "") as Record<string, Json>;
    const answers = raw["answers"] as Record<string, Record<string, Json>>;
    expect(typeof answers["tone"]?.["score"]).toBe("number");
  });

  it("does not apply a page with problems", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":sketch");
    a.sketch?.lines.push("stray line");
    a.handle({ kind: "key", event: ctrl("s") });
    const ed = a.sketch;
    expect(ed, "still open").toBeDefined();
    if (!ed) return;
    expect(ed.message).toContain("1 problem to fix");
    expect(ed.row, "the cursor jumps to the problem").toBe(ed.lines.length - 1);
    expect(a.session.questions, "the session is untouched").toHaveLength(3);

    a.handle({ kind: "key", event: key({ kind: "esc" }) });
    a.handle({ kind: "key", event: key({ kind: "esc" }) });
    expect(a.sketch).toBeUndefined();
    expect(transcript(a)).toContain("session unchanged");
  });

  it("opens the page with Ctrl-K and prints it with :sketch show", () => {
    const a = app();
    a.exec(":preset lead");
    a.handle({ kind: "key", event: ctrl("k") });
    expect(a.sketch).toBeDefined();
    a.handle({ kind: "key", event: key({ kind: "esc" }) });
    a.exec(":sketch show");
    const text = transcript(a);
    expect(text).toContain("has_budget? The sender indicates budget");
    expect(text).toContain("smb = Under 50 people");
    // Long level lists go one level per line, each after a `<`.
    expect(text).toContain("< Researching options");
  });

  it("saves and opens .jev files as sketches", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-sketch-"));
    const path = join(dir, "triage.jev");
    try {
      const a = app();
      a.exec(":preset triage");
      const before = a.session.requestJson("x");
      a.exec(`:save ${path}`);
      expect(readFileSync(path, "utf8")).toContain("department: Which team");

      const fresh = app();
      fresh.exec(`:open ${path}`);
      expect(fresh.session.requestJson("x")).toBe(before);

      writeFileSync(path, "text\n---\nbroken line\n");
      fresh.exec(`:open ${path}`);
      expect(transcript(fresh)).toContain(":3: not a question");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("draws the page with its gutter and preview", () => {
    const a = app();
    a.exec(":preset triage");
    a.exec(":sketch");
    const draw = (width = 140, height = 40): string => {
      const buffer = new ScreenBuffer(width, height);
      render(buffer, a);
      return buffer.toString();
    };

    let drawn = draw();
    expect(drawn).toContain("sketch · the request as one page");
    expect(drawn).toContain("choice │department: Which team");
    expect(drawn).toContain("level  │  Calm, just stating facts");
    expect(drawn, "the json preview").toContain('"type": "choice"');
    expect(drawn, "the status line").toContain("state — the text or JSON");

    // A problem is marked in the gutter, listed in the preview and explained on its line.
    const ed = a.sketch;
    expect(ed).toBeDefined();
    if (!ed) return;
    ed.lines.push("stray");
    ed.row = ed.lines.length - 1;
    for (const preview of ["answers", "ts"] as const) {
      ed.preview = preview;
      drawn = draw();
    }
    expect(drawn).toContain("?     !│stray");
    expect(drawn).toContain("1 problem(s)");
    expect(drawn).toContain("problems");
    expect(drawn).toContain("only takes `yes: …` and `no: …` lines");
    expect(drawn, "the ts preview").toContain('from "jev-repl"');

    // Small terminals still draw without throwing.
    expect(() => draw(30, 6)).not.toThrow();
  });
});

describe("a question's bar", () => {
  const BARRED = `A payout failed.
---
# thresholds were calibrated on 40 tickets
is_urgent? The message conveys urgency
  yes: A deadline
  @threshold 0.62

department: Which team should handle this
  @confidence 0.7
  billing = Payment or subscription issues
  technical = Bugs or integration problems

frustration: How frustrated the customer appears
  Calm < Annoyed < Furious
`;

  it("reads @threshold under a noul and @confidence under a choice, wherever in the block", () => {
    const parsed = sketch.parse(BARRED);
    expect(parsed.problems).toEqual([]);
    expect([...parsed.bars]).toEqual([
      ["is_urgent", 0.62],
      ["department", 0.7],
    ]);
    expect(parsed.tags[5]).toBe("bar");
    expect(parsed.tags[8]).toBe("bar");
    expect(sketch.tagLabel("bar")).toBe("bar");
    expect(sketch.tagColor("bar")).toBe("lightBlue");
    expect(parsed.blocks.get("is_urgent")).toEqual({ head: 3, last: 5, bar: 5 });
    expect(parsed.blocks.get("department")).toEqual({ head: 7, last: 10, bar: 8 });
    expect(parsed.blocks.get("frustration")).toEqual({ head: 12, last: 13, bar: undefined });
  });

  it("keeps the bar off the wire, and on the page", () => {
    const session = sketch.parse(BARRED).toSession();
    expect(session.requestJson("x")).not.toContain("0.62");
    const page = sketch.render(session);
    expect(page).toContain("  yes: A deadline\n  @threshold 0.62\n");
    expect(page).toContain("  technical = Bugs or integration problems\n  @confidence 0.7\n");
    const again = sketch.parse(page);
    expect([...again.bars]).toEqual([...session.bars]);
    expect(sketch.render(again.toSession())).toBe(page);
  });

  it("says what is wrong with a bar, on its line", () => {
    const problem = (text: string): string | undefined => sketch.parse(text).problems[0]?.message;
    expect(problem("s\n---\nq? x\n  @threshold 1.5\n")).toBe(
      "`@threshold` takes a number from 0 to 1, e.g. `@threshold 0.6`",
    );
    expect(problem("s\n---\nq? x\n  @threshold 1e-1\n")).toContain("takes a number from 0 to 1");
    expect(problem("s\n---\nq: x\n  a = 1\n  b = 2\n  @confidence\n")).toBe(
      "`@confidence` takes a number from 0 to 1, e.g. `@confidence 0.6`",
    );
    expect(problem("s\n---\n@threshold 0.5\nq? x\n")).toBe(
      "`@threshold` belongs under a question — put it below the `name?` line it sets",
    );
    expect(problem("s\n---\n@confidence 0.5\nq? x\n")).toBe(
      "`@confidence` belongs under a question — put it below the choice or score it gates",
    );
    expect(problem("s\n---\nq? x\n  @confidence 0.5\n")).toBe(
      "a yes/no question takes `@threshold`, not `@confidence`",
    );
    expect(problem("s\n---\nq: x\n  a < b\n  @threshold 0.5\n")).toBe(
      "a choice or a score takes `@confidence`, not `@threshold`",
    );
    expect(problem('s\n---\nq! {"type": "noul"}\n@threshold 0.5\n')).toBe(
      "a raw question takes no bar — jev cannot read its answer",
    );
    expect(problem("s\n---\nq? x\n  @threshold 0.5\n  @threshold 0.6\n")).toBe(
      "`q` already has a bar on line 4",
    );
    expect(problem("s\n---\n@speed fast\n")).toBe(
      "unknown directive `@speed`; there is `@model`, and `@threshold` or `@confidence` under a question",
    );
    const broken = sketch.parse("s\n---\nq:\n  @confidence 0.5\n");
    expect(broken.tags[3]).toBe("bar");
    expect(broken.problems.map((p) => p.line)).toEqual([2]);
  });

  it("writes bars back without touching anything else on the page", () => {
    const written = sketch.setBars(
      BARRED,
      new Map([
        ["is_urgent", 0.6],
        ["frustration", 0.55],
        ["nobody", 0.5],
      ]),
    );
    expect(written).toBe(
      BARRED.replace("@threshold 0.62", "@threshold 0.6").replace(
        "  Calm < Annoyed < Furious\n",
        "  Calm < Annoyed < Furious\n  @confidence 0.55\n",
      ),
    );
    const inline = sketch.setBars(
      "s\n---\nq? x | yes: y\nr: z\n    a = 1\n    b = 2",
      new Map([
        ["q", 0.3],
        ["r", 0.8],
      ]),
    );
    expect(inline).toBe(
      "s\n---\nq? x | yes: y\n  @threshold 0.3\nr: z\n    a = 1\n    b = 2\n    @confidence 0.8",
    );
    const crlf = sketch.setBars("s\r\n---\r\nq? x\r\n", new Map([["q", 0.4]]));
    expect(crlf).toBe("s\r\n---\r\nq? x\r\n  @threshold 0.4\r\n");
  });

  it("moves with its question, and goes when the question does", () => {
    const session = sketch.parse(BARRED).toSession();
    expect(session.thresholdOf("is_urgent", 0.5)).toBe(0.62);
    expect(session.thresholdOf("department", 0.5)).toBe(0.5);
    expect(session.thresholdOf("frustration", 0.5)).toBe(0.5);
    const copy = session.clone();
    copy.remove("is_urgent");
    expect(copy.bar("is_urgent")).toBeUndefined();
    expect(session.bar("is_urgent")).toBe(0.62);
    const [, department] = session.questions[1] as [string, sketch.ParsedSketch["questions"][0][1]];
    session.insert("department", department);
    expect(session.bar("department")).toBe(0.7);
    const [, urgent] = session.questions[0] as [string, sketch.ParsedSketch["questions"][0][1]];
    session.insert("department", urgent);
    expect(session.bar("department")).toBeUndefined();
  });

  it("survives :save and :open, and the answers are read at it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bar-"));
    const path = join(dir, "triage.jev");
    try {
      writeFileSync(path, BARRED);
      const a = app();
      a.exec(`:open ${path}`);
      expect(a.session.bar("is_urgent")).toBe(0.62);
      a.exec(`:save ${path}`);
      expect(readFileSync(path, "utf8")).toContain("@threshold 0.62");
      a.exec(":ask");
      expect(transcript(a)).toContain("at threshold 0.62");
      expect(transcript(a)).not.toContain("at threshold 0.50");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a changed bar as a change when a page is applied", () => {
    const a = app();
    a.exec(":preset triage");
    a.handle({ kind: "key", event: ctrl("k") });
    const editor = a.sketch as Editor;
    const at = editor.lines.findIndex((l) => l.startsWith("is_urgent?"));
    editor.lines.splice(at + 1, 0, "  @threshold 0.8");
    a.handle({ kind: "key", event: ctrl("s") });
    expect(a.session.bar("is_urgent")).toBe(0.8);
    expect(transcript(a)).not.toContain("nothing changed.");
  });
});
