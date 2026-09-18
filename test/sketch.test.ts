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
import { Buffer } from "../src/tui/buffer.js";
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
      ["text\n---\nok? Fine\n  maybe = so\n", 3, "only takes `yes"],
      ["text\n---\nsev: How bad\n  a < b\n  maybe = so\n", 2, "are mixed"],
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
      const buffer = new Buffer(width, height);
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
