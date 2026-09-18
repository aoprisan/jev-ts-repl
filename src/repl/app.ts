/** REPL state: the transcript, the input line, the session being built, and what each command does. */

import { readFileSync, writeFileSync } from "node:fs";

import type { Json } from "../json.js";
import { pretty } from "../json.js";
import { Client } from "../typesafe/client.js";
import { API_KEY_ENV } from "../typesafe/constants.js";
import { questionToJson } from "../typesafe/questions.js";
import type { Answer, ListModelsResponse, SystemOneResponse } from "../typesafe/responses.js";
import type { KeyEvent } from "../tui/keys.js";
import { isCtrl } from "../tui/keys.js";
import type { Line } from "../tui/style.js";
import { blankLine, line, span } from "../tui/style.js";
import { Builder } from "./builder.js";
import * as codegen from "./codegen.js";
import * as cost from "./cost.js";
import { Editor } from "./editor.js";
import {
  ACCENT,
  answerLines,
  BAD,
  bold,
  costLines,
  dim,
  errorLines,
  plain,
  questionLines,
  SCORE,
  styled,
  WARN,
} from "./format.js";
import * as highlight from "./highlight.js";
import { LESSONS } from "./lessons.js";
import * as mock from "./mock.js";
import * as presets from "./presets.js";
import type { Entry, Parsed } from "./session.js";
import { fromBody, parseChoice, parseNoul, parseRaw, parseScore, Session } from "./session.js";
import * as sketch from "./sketch.js";

/** Everything that can move the app forward. */
export type Msg =
  | { kind: "key"; event: KeyEvent }
  | { kind: "tick" }
  | { kind: "answered"; response?: SystemOneResponse; error?: unknown; elapsedMs: number }
  | { kind: "models"; response?: ListModelsResponse; error?: unknown };

export const COMMANDS: ReadonlyArray<readonly [string, string]> = [
  [":help", "this list; :help concepts for the model itself"],
  [":lesson", "guided track — :lesson next|prev|list|<n>"],
  [":try", "put the current lesson's command in the input line (Ctrl-T)"],
  [":preset", "load a ready-made session — :preset list"],
  [":state", "set the state — :state <text> | :state json {…} | :state clear"],
  [":noul", ":noul <name> <instructions> [| yes: …] [| no: …]"],
  [":choice", ":choice <name> <instructions> | label=desc | label=desc"],
  [":score", ":score <name> <instructions> | level | level | …"],
  [":raw", ':raw <name> {"type": …} — a hand-built question object'],
  [":build", "builder mode: a form with a live JSON preview (Ctrl-B)"],
  [
    ":sketch",
    "sketch mode: the whole request as one page of text (Ctrl-K) — :sketch show prints it",
  ],
  [":questions", "list what will be sent"],
  [":rm", ":rm <name> — drop one question"],
  [":reset", "empty the session"],
  [":ask", "send it (or press Enter on an empty line)"],
  [":json", "the exact request body this session POSTs"],
  [":last", "the last raw response body"],
  [":cost", "what a call costs — :cost <in>/<out> sets dollars per million tokens"],
  [":ts", "this session as a TypeScript program"],
  [":rust", "this session as a Rust program against typesafe-ai-sdk"],
  [":threshold", ":threshold <0-1> — what counts as a yes for a noul"],
  [":model", ":model [name] — per-session model"],
  [":models", "models the account can use"],
  [":timeout", ":timeout <seconds> — per-attempt timeout"],
  [":mock", ":mock on|off — offline simulated answers"],
  [":key", ":key [<api-key>] — API key status, or set one"],
  [":save", ":save <path> / :open <path> — session JSON, or a sketch if the path ends in .jev"],
  [":clear", "clear the transcript (Ctrl-L)"],
  [":quit", "leave (Ctrl-C)"],
];

const CONCEPTS: ReadonlyArray<readonly [string, string]> = [
  [
    "state",
    "The thing being judged: a string, or any JSON — a ticket, a draft reply, a diff, a row.",
  ],
  [
    "noul",
    "A yes/no question answered with a probability from 0 to 1. You choose the threshold; the model never does.",
  ],
  [
    "choice",
    "One label out of a set you define, with the probability of every label and a confidence over the spread.",
  ],
  [
    "score",
    "Ordered levels you define. The answer is probability-weighted, so 1.4 sits between level 1 and 2.",
  ],
  [
    "criteria",
    "The descriptions attached to a question — what a yes means, what each option or level means. Vague criteria are what low confidence usually means.",
  ],
  [
    "confidence",
    "How concentrated the distribution is. Gate automation on it and send the rest to a human.",
  ],
  [
    "names",
    "Questions are a name → question map, and answers come back under the same names. Keep names stable across versions.",
  ],
];

export class App {
  session = new Session();
  transcript: Line[] = [];
  input = "";
  cursor = 0;
  history: string[] = [];
  /** Lines scrolled back from the bottom; 0 follows the tail. */
  scroll = 0;
  client: Client | undefined;
  mock: boolean;
  pending = false;
  spinner = 0;
  lesson = 0;
  lessonOpen = false;
  suggested: string | undefined;
  threshold = 0.5;
  timeoutMs: number | undefined;
  /** Dollars per million tokens, from `JEV_PRICE` or `:cost`; `undefined` shows tokens only. */
  rates: cost.Rates | undefined;
  lastRaw: string | undefined;
  /** Set while builder mode is open. */
  builder: Builder | undefined;
  /** Set while sketch mode is open. */
  sketch: Editor | undefined;
  quit = false;

  #histIdx: number | undefined;
  #stash = "";
  readonly #send: (msg: Msg) => void;

  constructor(send: (msg: Msg) => void = () => {}) {
    this.#send = send;
    this.rates = cost.ratesFromEnv(process.env[cost.PRICE_ENV]);
    try {
      this.client = Client.fromEnv();
    } catch {
      this.client = undefined;
    }
    this.mock = this.client === undefined;
    this.#banner();
  }

  modelName(): string {
    return this.session.model ?? this.client?.defaultModel ?? "jev-latest";
  }

  // ---- transcript -------------------------------------------------------------------------

  #push(l: Line): void {
    this.transcript.push(l);
    this.scroll = 0;
  }

  #extend(lines: readonly Line[]): void {
    this.transcript.push(...lines);
    this.scroll = 0;
  }

  #blank(): void {
    const last = this.transcript[this.transcript.length - 1];
    if (last === undefined || last.spans.length === 0) return;
    this.#push(blankLine());
  }

  #note(text: string): void {
    this.#push(line([dim(`  ${text}`)]));
  }

  #warn(text: string): void {
    this.#push(styled(`  ${text}`, WARN));
  }

  #bad(text: string): void {
    this.#push(styled(`  ${text}`, BAD));
  }

  #heading(text: string): void {
    this.#blank();
    this.#push(line([span(text, { fg: ACCENT, bold: true })]));
  }

  #banner(): void {
    this.#push(
      line([
        span("jev", { fg: ACCENT, bold: true }),
        dim("  ·  a playground for TypeSafe System One questions"),
      ]),
    );
    this.#push(
      line([
        dim(
          "  state in, typed answers out: noul (probability of yes), choice (one of N), score (ordered levels)",
        ),
      ]),
    );
    this.#blank();
    if (this.mock) {
      this.#push(
        line([
          span("  MOCK MODE", { fg: WARN, bold: true }),
          dim(`  no ${API_KEY_ENV}, so answers are simulated locally.`),
        ]),
      );
      this.#note(
        "Everything else is real: the same questions, the same wire format. :key <api-key> to go live.",
      );
    } else {
      this.#note(`Live against ${this.modelName()}.`);
    }
    this.#blank();
    this.#note(
      "Press Enter on an empty line to send. :help for commands, :lesson for the guided track, :sketch to write the whole request as a page.",
    );
    this.lessonOpen = true;
    this.suggested = LESSONS[0]?.tryThis;
  }

  // ---- events -----------------------------------------------------------------------------

  handle(msg: Msg): void {
    switch (msg.kind) {
      case "key":
        this.#key(msg.event);
        break;
      case "tick":
        this.spinner += 1;
        break;
      case "answered":
        this.pending = false;
        if (msg.response) {
          this.#showResponse(msg.response, msg.elapsedMs);
        } else {
          this.#blank();
          this.#extend(errorLines(msg.error));
        }
        break;
      case "models":
        this.pending = false;
        if (msg.response) {
          this.#heading("models");
          for (const m of msg.response.models) {
            this.#push(
              line([span("  "), bold(m.name), dim(`  ${m.release_date}  ${m.description}`)]),
            );
          }
        } else {
          this.#blank();
          this.#extend(errorLines(msg.error));
        }
        break;
    }
  }

  #key(event: KeyEvent): void {
    if (isCtrl(event, "c")) {
      this.quit = true;
      return;
    }
    if (this.builder) {
      this.#builderKey(event);
      return;
    }
    if (this.sketch) {
      this.#sketchKey(event);
      return;
    }
    if (isCtrl(event, "d")) {
      this.quit = true;
      return;
    }
    if (isCtrl(event, "b")) return this.#openBuilder("");
    if (isCtrl(event, "k")) return this.#openSketch();
    if (isCtrl(event, "l")) {
      this.transcript = [];
      this.scroll = 0;
      return;
    }
    if (isCtrl(event, "t")) return this.#loadSuggestion();
    if (isCtrl(event, "n")) return this.exec(":lesson next");
    if (isCtrl(event, "a")) {
      this.cursor = 0;
      return;
    }
    if (isCtrl(event, "e")) {
      this.cursor = [...this.input].length;
      return;
    }
    if (isCtrl(event, "u")) {
      this.input = "";
      this.cursor = 0;
      return;
    }
    if (isCtrl(event, "w")) return this.#deleteWord();

    const { code } = event;
    switch (code.kind) {
      case "char":
        if (!event.ctrl && !event.alt) this.#insert(code.char);
        break;
      case "backspace":
        if (this.cursor > 0) {
          this.cursor -= 1;
          this.#removeAt(this.cursor);
        }
        break;
      case "delete":
        this.#removeAt(this.cursor);
        break;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "right":
        this.cursor = Math.min(this.cursor + 1, [...this.input].length);
        break;
      case "home":
        this.cursor = 0;
        break;
      case "end":
        this.cursor = [...this.input].length;
        break;
      case "up":
        this.#recall(-1);
        break;
      case "down":
        this.#recall(1);
        break;
      case "pageUp":
        this.scroll += 10;
        break;
      case "pageDown":
        this.scroll = Math.max(0, this.scroll - 10);
        break;
      case "esc":
        if (this.scroll > 0) {
          this.scroll = 0;
        } else {
          this.input = "";
          this.cursor = 0;
        }
        break;
      case "tab":
        this.#complete();
        break;
      case "enter":
        this.#submit();
        break;
      default:
        break;
    }
  }

  #insert(c: string): void {
    const chars = [...this.input];
    chars.splice(this.cursor, 0, c);
    this.input = chars.join("");
    this.cursor += 1;
  }

  #removeAt(index: number): void {
    const chars = [...this.input];
    if (index >= chars.length) return;
    chars.splice(index, 1);
    this.input = chars.join("");
  }

  #deleteWord(): void {
    const chars = [...this.input];
    let i = this.cursor;
    while (i > 0 && /\s/.test(chars[i - 1] as string)) i -= 1;
    while (i > 0 && !/\s/.test(chars[i - 1] as string)) i -= 1;
    this.input = [...chars.slice(0, i), ...chars.slice(this.cursor)].join("");
    this.cursor = i;
  }

  #recall(delta: number): void {
    if (this.history.length === 0) return;
    let next: number | undefined;
    if (delta === -1) {
      if (this.#histIdx === undefined) {
        this.#stash = this.input;
        next = this.history.length - 1;
      } else {
        next = Math.max(0, this.#histIdx - 1);
      }
    } else if (this.#histIdx !== undefined && this.#histIdx + 1 < this.history.length) {
      next = this.#histIdx + 1;
    } else {
      next = undefined;
    }
    this.#histIdx = next;
    if (next === undefined) {
      this.input = this.#stash;
      this.#stash = "";
    } else {
      this.input = this.history[next] ?? "";
    }
    this.cursor = [...this.input].length;
  }

  #complete(): void {
    const word = this.input.trimStart();
    if (!word.startsWith(":") || word.includes(" ")) return;
    const matches = COMMANDS.map(([c]) => c).filter((c) => c.startsWith(word));
    if (matches.length === 1) {
      this.input = `${matches[0]} `;
      this.cursor = [...this.input].length;
    } else if (matches.length > 1) {
      this.#note(matches.join("  "));
    }
  }

  #loadSuggestion(): void {
    if (this.suggested === undefined) return;
    this.input = this.suggested;
    this.cursor = [...this.input].length;
  }

  #submit(): void {
    const text = this.input.trim();
    this.input = "";
    this.cursor = 0;
    this.#histIdx = undefined;
    if (text === "") {
      this.ask();
      return;
    }
    // An API key typed at the prompt is neither echoed nor kept in the history.
    const secret = text.startsWith(":key ");
    if (!secret && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.#blank();
    this.#push(line([span("› ", { fg: ACCENT }), span(secret ? ":key ••••••••" : text)]));
    this.exec(text);
  }

  // ---- commands ---------------------------------------------------------------------------

  exec(input: string): void {
    const text = input.trim();
    if (text === "") return;
    if (!text.startsWith(":")) {
      // Bare text is the most common thing to want: it becomes the state.
      this.#setState(text);
      return;
    }
    const at = text.search(/\s/);
    const cmd = at === -1 ? text : text.slice(0, at);
    const args = at === -1 ? "" : text.slice(at + 1).trim();

    switch (cmd) {
      case ":help":
      case ":h":
      case ":?":
        this.#help(args);
        break;
      case ":quit":
      case ":q":
      case ":exit":
        this.quit = true;
        break;
      case ":clear":
        this.transcript = [];
        this.scroll = 0;
        break;
      case ":lesson":
      case ":l":
        this.#lessonCmd(args);
        break;
      case ":try":
        this.#loadSuggestion();
        break;
      case ":preset":
        this.#preset(args);
        break;
      case ":state":
      case ":s":
        this.#stateCmd(args);
        break;
      case ":noul":
        this.#add(parseNoul(args));
        break;
      case ":choice":
        this.#add(parseChoice(args));
        break;
      case ":score":
        this.#add(parseScore(args));
        break;
      case ":raw":
        this.#add(parseRaw(args));
        break;
      case ":build":
      case ":b":
        this.#openBuilder(args);
        break;
      case ":sketch":
      case ":page":
        if (args === "show" || args === "print") this.#showSketch();
        else this.#openSketch();
        break;
      case ":questions":
      case ":qs":
        this.listQuestions();
        break;
      case ":rm":
      case ":drop":
        if (this.session.remove(args)) this.#note(`dropped ${args}`);
        else this.#warn(`no question named ${JSON.stringify(args)}`);
        break;
      case ":reset":
        this.session = new Session();
        this.#note("session emptied: no state, no questions");
        break;
      case ":ask":
      case ":send":
        this.ask();
        break;
      case ":json":
        this.#showRequest();
        break;
      case ":last":
        this.#showLast();
        break;
      case ":cost":
      case ":price":
        this.#costCmd(args);
        break;
      case ":ts":
      case ":typescript":
      case ":code":
        this.#showTypescript();
        break;
      case ":rust":
        this.#showRust();
        break;
      case ":threshold":
        this.#thresholdCmd(args);
        break;
      case ":model":
        this.#modelCmd(args);
        break;
      case ":models":
        this.#modelsCmd();
        break;
      case ":timeout":
        this.#timeoutCmd(args);
        break;
      case ":mock":
        this.#mockCmd(args);
        break;
      case ":key":
        this.#keyCmd(args);
        break;
      case ":save":
        this.#save(args);
        break;
      case ":open":
      case ":load":
        this.#open(args);
        break;
      default:
        this.#warn(`unknown command ${cmd}. :help lists them all.`);
    }
  }

  #help(topic: string): void {
    if (topic.startsWith("concept")) {
      this.#heading("what jev answers");
      for (const [title, body] of CONCEPTS) {
        this.#push(
          line([span("  "), span(title.padEnd(12), { fg: ACCENT, bold: true }), span(body)]),
        );
      }
      return;
    }
    this.#heading("commands");
    for (const [cmd, about] of COMMANDS) {
      this.#push(line([span("  "), span(cmd.padEnd(11), { fg: ACCENT }), span(" "), span(about)]));
    }
    this.#blank();
    this.#note("Bare text with no leading colon sets the state. Enter on an empty line sends.");
    this.#note(
      "Keys: Ctrl-T try the lesson's command · Ctrl-N next lesson · Ctrl-K sketch · PgUp/PgDn scroll · Ctrl-L clear · Ctrl-C quit",
    );
    this.#note(":help concepts explains noul, choice, score and confidence.");
  }

  #lessonCmd(args: string): void {
    const total = LESSONS.length;
    if (args === "list") {
      this.#heading("lessons");
      LESSONS.forEach((l, i) => {
        const marker = i === this.lesson ? "▸" : " ";
        this.#push(
          line([span(`  ${marker} `), dim(`${String(i + 1).padStart(2)}. `), span(l.title)]),
        );
      });
      this.#note("`:lesson 3` jumps to one.");
      return;
    }
    if (args === "next") {
      if (this.lessonOpen) this.lesson = Math.min(this.lesson + 1, total - 1);
    } else if (args === "prev" || args === "back") {
      this.lesson = Math.max(0, this.lesson - 1);
    } else if (args !== "") {
      const n = Number(args);
      if (Number.isInteger(n) && n >= 1 && n <= total) {
        this.lesson = n - 1;
      } else {
        this.#warn(`lessons run 1 to ${total}; try \`:lesson list\`.`);
        return;
      }
    }
    this.lessonOpen = true;
    const l = LESSONS[this.lesson];
    if (!l) return;
    this.#heading(`lesson ${this.lesson + 1}/${total}  ·  ${l.title}`);
    for (const para of l.body) {
      this.#push(plain(`  ${para}`));
      this.#push(blankLine());
    }
    this.#push(
      line([span("  "), span("try ", { fg: SCORE }), span(l.tryThis, { fg: SCORE, bold: true })]),
    );
    this.#note("Ctrl-T puts that in the input line · Ctrl-N for the next lesson");
    this.suggested = l.tryThis;
  }

  #preset(args: string): void {
    if (args === "" || args === "list") {
      this.#heading("presets");
      for (const p of presets.PRESETS) {
        this.#push(line([span("  "), span(p.name.padEnd(10), { fg: ACCENT }), span(p.about)]));
      }
      this.#note("`:preset triage` loads one; `:questions` then shows what it built.");
      return;
    }
    const preset = presets.find(args);
    if (!preset) {
      this.#warn(`no preset ${JSON.stringify(args)}; \`:preset list\` has them.`);
      return;
    }
    this.session = new Session();
    for (const l of preset.script) this.exec(l);
    this.#heading(`preset ${preset.name}`);
    this.#note(preset.about);
    this.#note("`:ask` to send it, `:json` to see the body, `:questions` to review.");
  }

  #stateCmd(args: string): void {
    if (args === "") {
      this.#heading("state");
      if (this.session.stateIsEmpty()) {
        this.#note("empty — type any text (no colon) or `:state <text>` to set it.");
      } else {
        this.#extend(highlight.json(pretty(this.session.state)));
      }
      return;
    }
    if (args === "clear") {
      this.session.state = "";
      this.#note("state cleared");
      return;
    }
    const at = args.search(/\s/);
    if (at !== -1 && args.slice(0, at) === "json") {
      const rest = args.slice(at + 1).trim();
      try {
        this.#setState(JSON.parse(rest) as Json);
      } catch (e) {
        this.#bad(`not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    this.#setState(args);
  }

  #setState(value: Json): void {
    this.session.state = value;
    const preview = this.session.statePreview();
    const chars = [...preview];
    const shown = chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : preview;
    this.#note(`state ← ${shown}`);
    if (this.session.questions.length === 0) {
      this.#note("now add a question: :noul, :choice or :score (`:preset triage` loads a set).");
    }
  }

  #add(parsed: Parsed<Entry>): void {
    if (!parsed.ok) {
      this.#bad(parsed.error);
      return;
    }
    const [name, question] = parsed.value;
    const replaced = this.session.insert(name, question);
    this.#extend(questionLines(this.session.indexOf(name), name, question));
    if (replaced) this.#note(`replaced ${name}`);
    if (this.session.questions.length === 1) {
      this.#note("Enter on an empty line sends the session.");
    }
  }

  listQuestions(): void {
    this.#heading(`questions (${this.session.questions.length})`);
    if (this.session.questions.length === 0) {
      this.#note("none yet — :noul, :choice, :score, or :preset triage");
      return;
    }
    this.session.questions.forEach(([name, q], i) => this.#extend(questionLines(i, name, q)));
  }

  /** Builder mode: the same question, built in a form, with the JSON shown as it is typed. */
  #openBuilder(name: string): void {
    const state =
      typeof this.session.state === "string"
        ? this.session.state
        : this.session.state === null
          ? ""
          : this.session.statePreview();
    this.builder = new Builder(state, name.trim());
    this.#note("builder mode — Tab moves, Ctrl-S adds the question, Esc closes.");
  }

  #builderKey(event: KeyEvent): void {
    const builder = this.builder;
    if (!builder) return;
    const outcome = builder.key(event);
    if (outcome.kind === "open") return;
    if (outcome.kind === "cancel") {
      this.builder = undefined;
      this.#note("builder closed");
      return;
    }
    const command = builder.asCommand();
    const { name, question, state } = outcome;
    if (state.trim() !== "" && state !== this.session.state) this.session.state = state;
    this.#blank();
    this.#push(line([span("› ", { fg: ACCENT }), span(command)]));
    this.#note("(what builder mode just built — the one-line form does the same thing)");
    this.#add({ ok: true, value: [name, question] });
    // Stay in the form so the next question is one keystroke away.
    this.builder = new Builder(state, "");
  }

  /** Sketch mode: the whole session on one page, parsed as it is typed. */
  #openSketch(): void {
    const editor = new Editor(sketch.render(this.session));
    if (this.session.stateIsEmpty() && this.session.questions.length === 0) {
      editor.preview = "answers";
    }
    this.sketch = editor;
    this.#note(
      "sketch mode — write the state, a --- line, then questions. ^S applies, ^G applies and sends, Esc closes.",
    );
  }

  #sketchKey(event: KeyEvent): void {
    const editor = this.sketch;
    if (!editor) return;
    const outcome = editor.key(event);
    if (outcome === "open") return;
    if (outcome === "cancel") {
      this.sketch = undefined;
      this.#note("sketch closed, session unchanged");
      return;
    }
    const send = outcome === "applyAndAsk";
    const parsed = editor.parsed();
    if (!parsed.ok()) {
      const n = parsed.problems.length;
      const first = parsed.problems[0];
      if (first) {
        editor.row = Math.min(first.line, editor.lines.length - 1);
        editor.col = 0;
        editor.message = `${n} problem${n === 1 ? "" : "s"} to fix first — line ${first.line + 1}: ${first.message}`;
      }
      return;
    }
    const text = editor.text();
    this.sketch = undefined;
    this.#applySketch(parsed, text);
    if (send) this.ask();
  }

  /** Replace the session with a parsed page and say what changed. */
  #applySketch(parsed: sketch.ParsedSketch, text: string): void {
    const before = this.session.requestJson(this.modelName());
    // The page is the whole request: no `@model` line means the client default.
    this.session = parsed.toSession();
    const after = this.session.requestJson(this.modelName());
    this.#blank();
    this.#push(line([span("› ", { fg: ACCENT }), dim("sketch applied")]));
    if (before === after) {
      this.#note("nothing changed.");
      return;
    }
    this.#extend(sketch.highlight(text.replace(/\s+$/, "")));
    const n = this.session.questions.length;
    this.#note(
      `session ← ${n} question${n === 1 ? "" : "s"} from the page. Enter sends it; :json shows the body.`,
    );
  }

  #showSketch(): void {
    this.#heading("this session, as a sketch");
    const text = sketch.render(this.session);
    this.#extend(sketch.highlight(text.replace(/\s+$/, "")));
    this.#note(
      "`name?` asks yes/no · `label = why` lines make a choice · `low < high` makes a score · :sketch opens it for editing.",
    );
  }

  #showRequest(): void {
    this.#heading("POST /v1/systemone");
    this.#extend(highlight.json(this.session.requestJson(this.modelName())));
    this.#note(
      "Questions are a name → {type, instructions, criteria} map; answers come back under the same names.",
    );
  }

  #showLast(): void {
    if (this.lastRaw === undefined) {
      this.#note("nothing sent yet.");
      return;
    }
    this.#heading("last response body");
    this.#extend(highlight.json(this.lastRaw));
  }

  /** `:cost` estimates the next call; `:cost <in>/<out>` puts a price on it, `:cost off` drops it. */
  #costCmd(args: string): void {
    if (args === "off" || args === "clear" || args === "none") {
      this.rates = undefined;
      this.#note("rates cleared — :cost now counts tokens only.");
      return;
    }
    if (args !== "") {
      const parsed = cost.parseRates(args);
      if (!parsed.ok) {
        this.#bad(parsed.error);
        return;
      }
      this.rates = parsed.value;
      this.#note(`rates ← ${cost.formatRates(parsed.value)}`);
    }
    if (this.session.questions.length === 0) {
      this.#warn(
        "nothing to price yet — :noul, :choice or :score first (`:preset triage` loads a set).",
      );
      return;
    }
    this.#heading(`cost estimate  ·  ${this.modelName()}`);
    this.#extend(
      costLines(
        cost.estimate(this.session, this.modelName()),
        this.rates,
        ":cost 0.20/1.00 prices it: dollars per million tokens, input then output",
      ),
    );
    this.#note(
      "Tokens are estimated from the body, not counted by the API's tokenizer; `usage` on a live answer is the real thing.",
    );
    this.#note(
      "Answer sizes come from the shapes you asked for: a score echoes its legend, a choice one probability per label.",
    );
    if (this.rates !== undefined) {
      this.#note(
        `${cost.PRICE_ENV}=${cost.ratesValue(this.rates)} sets the same rates at startup.`,
      );
    }
  }

  #showTypescript(): void {
    const code = codegen.typescript(this.session, this.modelName(), this.threshold);
    this.#heading("this session, as TypeScript");
    this.#extend(highlight.typescript(code));
  }

  #showRust(): void {
    const code = codegen.rust(this.session, this.modelName(), this.threshold);
    this.#heading("this session, as Rust");
    this.#extend(highlight.rust(code));
  }

  #thresholdCmd(args: string): void {
    if (args === "") {
      this.#note(`threshold ${this.threshold.toFixed(2)}`);
      return;
    }
    const t = Number(args);
    if (!Number.isFinite(t) || t < 0 || t > 1) {
      this.#bad("threshold takes a number from 0 to 1, e.g. :threshold 0.8");
      return;
    }
    this.threshold = t;
    const shown = t.toFixed(2);
    this.#note(
      `threshold ${shown} — a noul now reads as yes at ${shown} or above (that is \`answer.noul >= ${shown}\`)`,
    );
  }

  #modelCmd(args: string): void {
    if (args === "") {
      this.#note(`model ${this.modelName()}`);
      this.#note("`jev-latest` moves with releases; pin a version for reproducibility.");
      return;
    }
    this.session.model = args;
    this.#note(`model ← ${args}`);
  }

  #modelsCmd(): void {
    if (this.mock || !this.client) {
      this.#heading("models (mock)");
      for (const m of mock.models()) {
        this.#push(line([span("  "), bold(m.name), dim(`  ${m.release_date}  ${m.description}`)]));
      }
      this.#note("simulated — :key <api-key> to list the real ones.");
      return;
    }
    const client = this.client;
    this.pending = true;
    this.#note("GET /v1/models …");
    void client
      .models()
      .list()
      .then(
        (response) => this.#send({ kind: "models", response }),
        (error: unknown) => this.#send({ kind: "models", error }),
      );
  }

  #timeoutCmd(args: string): void {
    if (args === "") {
      this.#note(
        this.timeoutMs === undefined
          ? "timeout 10s per attempt (the client default)"
          : `timeout ${(this.timeoutMs / 1000).toFixed(1)}s per attempt`,
      );
      return;
    }
    const seconds = Number(args);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      this.#bad("timeout takes seconds, e.g. :timeout 3");
      return;
    }
    this.timeoutMs = seconds * 1000;
    this.#note(
      `timeout ← ${seconds.toFixed(1)}s per attempt; retries still get their own attempts within a 30s budget`,
    );
  }

  #mockCmd(args: string): void {
    if (args === "on") {
      this.mock = true;
    } else if (args === "off") {
      if (!this.client) {
        this.#warn("no API key, so mock mode stays on. :key <api-key> to go live.");
        return;
      }
      this.mock = false;
    } else if (args !== "") {
      this.#bad("`:mock on` or `:mock off`");
      return;
    }
    this.#note(
      this.mock
        ? "mock on — answers are simulated locally, deterministic per state and question."
        : `mock off — live against ${this.modelName()}.`,
    );
  }

  #keyCmd(args: string): void {
    if (args === "") {
      const key = process.env[API_KEY_ENV];
      this.#note(
        key && key.trim() !== ""
          ? `${API_KEY_ENV} is set (${masked(key)}).`
          : `${API_KEY_ENV} is not set — :key <api-key> sets one for this session.`,
      );
      if (this.client) this.#note(`client ready, default model ${this.modelName()}`);
      return;
    }
    try {
      this.client = new Client({ apiKey: args });
      this.mock = false;
      this.#note(`key accepted (${masked(args)}); mock off, calls go to the API now.`);
    } catch (e) {
      this.#extend(errorLines(e));
    }
  }

  #save(path: string): void {
    if (path === "") {
      this.#bad(":save <path>");
      return;
    }
    const body = path.endsWith(".jev")
      ? sketch.render(this.session)
      : this.session.requestJson(this.modelName());
    try {
      writeFileSync(path, body);
      this.#note(`wrote ${path}`);
    } catch (e) {
      this.#bad(`could not write ${path}: ${message(e)}`);
    }
  }

  #open(path: string): void {
    if (path === "") {
      this.#bad(":open <path>");
      return;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      this.#bad(`could not read ${path}: ${message(e)}`);
      return;
    }
    if (path.endsWith(".jev")) {
      const parsed = sketch.parse(text);
      const problem = parsed.problems[0];
      if (problem) {
        this.#bad(`${path}:${problem.line + 1}: ${problem.message}`);
        return;
      }
      this.session = parsed.toSession();
      this.#note(`loaded ${path}`);
      this.listQuestions();
      return;
    }
    const parsed = fromBody(text);
    if (!parsed.ok) {
      this.#bad(parsed.error);
      return;
    }
    this.session = parsed.value;
    this.#note(`loaded ${path}`);
    this.listQuestions();
  }

  // ---- asking -----------------------------------------------------------------------------

  ask(): void {
    if (this.pending) {
      this.#warn("a request is already in flight.");
      return;
    }
    if (this.session.questions.length === 0) {
      this.#warn(
        "no questions yet — :noul, :choice or :score first (`:preset triage` loads a set).",
      );
      return;
    }
    if (this.session.stateIsEmpty()) {
      this.#warn("no state yet — type the text to judge, or `:state <text>`.");
      return;
    }
    if (this.mock || !this.client) {
      this.#askMock();
      return;
    }
    const client = this.client;
    const state = this.session.state;
    const questions = this.session.questions.map(([name, q]) => [name, q] as const);
    const model = this.modelName();
    const started = Date.now();
    this.pending = true;
    this.#blank();
    this.#push(
      line([
        dim("  POST /v1/systemone  "),
        dim(model),
        dim(`  ${this.session.questions.length} question(s)`),
      ]),
    );
    const options = this.timeoutMs === undefined ? { model } : { model, timeoutMs: this.timeoutMs };
    void client.systemOne(state, questions, options).then(
      (response) => this.#send({ kind: "answered", response, elapsedMs: Date.now() - started }),
      (error: unknown) => this.#send({ kind: "answered", error, elapsedMs: Date.now() - started }),
    );
  }

  #askMock(): void {
    const answers: Array<[string, Answer | undefined]> = this.session.questions.map(
      ([name, q]) =>
        [name, mock.answer(this.session.state, name, questionToJson(q))] as [
          string,
          Answer | undefined,
        ],
    );

    this.#blank();
    this.#push(
      line([span("  answers  ", { fg: WARN, bold: true }), dim(`simulated · ${this.modelName()}`)]),
    );
    for (const [name, answer] of answers) {
      if (answer) this.#extend(answerLines(name, answer, this.threshold));
      else this.#warn(`${name}: mock mode cannot simulate this question shape.`);
    }
    this.lastRaw = pretty(mock.mockBody(answers, this.modelName()));
    const estimated = cost.estimate(this.session, this.modelName());
    const spent = this.rates === undefined ? undefined : cost.priceEstimate(estimated, this.rates);
    this.#note(
      `≈ ${estimated.inputTokens} in / ${estimated.outputTokens} out tokens${spent === undefined ? "" : ` · ${cost.usd(spent.total)}`} — estimated, since nothing was sent (:cost breaks it down).`,
    );
    this.#note(
      "Mock numbers are deterministic noise, not judgement. :key <api-key> for real answers.",
    );
  }

  #showResponse(res: SystemOneResponse, elapsedMs: number): void {
    this.#blank();
    const tokens =
      res.usage.inputTokens !== undefined && res.usage.outputTokens !== undefined
        ? ` · ${res.usage.inputTokens} in / ${res.usage.outputTokens} out tokens`
        : "";
    const spent = this.rates === undefined ? undefined : cost.priceUsage(res.usage, this.rates);
    const money = spent === undefined ? "" : ` · ${cost.usd(spent.total)}`;
    this.#push(
      line([
        span("  answers  ", { fg: ACCENT, bold: true }),
        dim(
          `${res.model} · ${elapsedMs.toFixed(0)} ms · ${res.meta.attempts} attempt(s)${tokens}${money}`,
        ),
      ]),
    );
    for (const [name, answer] of res.answers) {
      this.#extend(answerLines(name, answer, this.threshold));
    }
    if (res.requestId !== undefined) this.#note(`request_id ${res.requestId}`);
    this.lastRaw = pretty(res.raw);
  }
}

function masked(key: string): string {
  return `…${[...key].slice(-4).join("")}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
