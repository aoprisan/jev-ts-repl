/**
 * The web REPL: the same notation, the same parser, the same generators as the terminal, drawn in
 * DOM instead of a terminal buffer.
 *
 * Nothing here re-implements jev. The page is parsed by `sketch.parse`, answers are simulated by
 * `mock.answer` and drawn by `format.answerLines`, code comes out of `codegen`, and the live call
 * goes through the same `Client`. This file is a view.
 */

import type { Answer, ChoiceOption, Json, Question, Session as SessionType } from "jev-repl/core";
import {
  choice,
  Client,
  codegen,
  compact,
  cost,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  format,
  LESSONS,
  linesText,
  mock,
  noul,
  PRESETS,
  score,
  Session,
  sketch,
} from "jev-repl/core";

import { clear, h, lines as styledLines } from "./dom.js";
import { applyAll, apply as applyCommand } from "./script.js";
import * as share from "./share.js";
import {
  DEFAULTS,
  forgetKey,
  loadKey,
  loadSettings,
  rememberKey,
  saveSettings,
  type Settings,
} from "./store.js";

type Tab = "page" | "build" | "learn" | "preview";
type PreviewKind = "json" | "answers" | "ts" | "rust" | "cost";

interface Ask {
  readonly model: string;
  readonly answers: ReadonlyArray<[string, Answer | undefined]>;
  readonly raw: Json;
  readonly live: boolean;
  /** What the API said it spent, when it said anything. */
  readonly usage?: { inputTokens?: number; outputTokens?: number };
}

interface State {
  page: string;
  tab: Tab;
  preview: PreviewKind;
  settings: Settings;
  key: string | undefined;
  last: Ask | undefined;
  lesson: number;
  status: string;
}

const START = [
  "I've been trying to connect my Stripe account for 3 days and it keeps failing.",
  "I'm losing sales. Please help ASAP.",
  "---",
  "is_urgent? The message conveys urgency or time-sensitivity",
  "  yes: A deadline, or money being lost right now",
  "department: Which team should handle this",
  "  billing = Payment or subscription issues",
  "  technical = Bugs or integration problems",
  "  sales = Pricing or account questions",
  "frustration: How frustrated the customer appears",
  "  Calm, just stating facts < Frustrated but civil < Very angry",
].join("\n");

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
};

const text = (value: Json | undefined): string =>
  value === undefined ? "" : typeof value === "string" ? value : compact(value);

const state: State = {
  page: START,
  tab: "page",
  preview: "json",
  settings: { ...DEFAULTS },
  key: undefined,
  last: undefined,
  lesson: 0,
  status: "",
};

const pageInput = el<HTMLTextAreaElement>("page");
const gutter = el<HTMLDivElement>("gutter");
const problems = el<HTMLDivElement>("problems");
const preview = el<HTMLDivElement>("preview");
const cards = el<HTMLDivElement>("cards");
const stateInput = el<HTMLTextAreaElement>("state");
const lessonBox = el<HTMLDivElement>("lesson");
const statusLine = el<HTMLDivElement>("status");
const modePill = el<HTMLButtonElement>("mode");
const settingsDialog = el<HTMLDialogElement>("settings");

// ---------------------------------------------------------------- session helpers

const parsed = (): ReturnType<typeof sketch.parse> => sketch.parse(state.page);

const modelName = (session?: SessionType): string =>
  session?.model ?? (state.settings.model === "" ? DEFAULT_MODEL : state.settings.model);

const isLive = (): boolean => state.key !== undefined && state.key !== "";

/** Where the rates come from on this host, for the line the table shows without them. */
const HOW_TO_PRICE = "Key → price sets dollars per million tokens, input then output";

/** Rates for the cost preview: whatever the settings hold, if it parses. */
const rates = (): cost.Rates | undefined => cost.ratesFromEnv(state.settings.price);

function setPage(next: string): void {
  state.page = next;
  if (pageInput.value !== next) pageInput.value = next;
  persist();
  draw();
}

function persist(): void {
  saveSettings({ ...state.settings, page: state.page });
}

function say(message: string): void {
  state.status = message;
  statusLine.textContent = message;
}

// ---------------------------------------------------------------- the page tab

/**
 * The width the stylesheet stops scrolling the page sideways at and starts wrapping it. Whether a
 * line wrapped is read off the textarea itself; this is only here to ask for a redraw on the way
 * across, since the gutter's rows are measured and the measurement is now a different one.
 */
const WRAPPED = window.matchMedia("(max-width: 700px)");

/** A copy of the page, laid out at the textarea's width, only ever asked how tall its lines are. */
const mirror = h("div", { class: "mirror", "aria-hidden": "true" });

/**
 * How tall each line of the page is once it has wrapped, or nothing when it does not wrap — the
 * gutter's own row height is right in that case, and on a screen wide enough to scroll sideways
 * every line is one row.
 *
 * The measurement is a copy rather than a guess: the same text, the same font, the same width as
 * the textarea's content box, so the browser breaks it in the same places.
 */
function lineHeights(rows: readonly string[]): number[] | undefined {
  const style = window.getComputedStyle(pageInput);
  // The page is scrolling sideways instead of wrapping, so every line is one row, as drawn.
  if (style.whiteSpace !== "pre-wrap") return undefined;
  const width =
    pageInput.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  // The panel is hidden, so there is nothing to measure against; the resize observer comes back.
  if (!(width > 0)) return undefined;
  mirror.style.width = `${width}px`;
  mirror.style.fontFamily = style.fontFamily;
  mirror.style.fontSize = style.fontSize;
  mirror.style.fontStyle = style.fontStyle;
  mirror.style.fontWeight = style.fontWeight;
  mirror.style.lineHeight = style.lineHeight;
  mirror.style.letterSpacing = style.letterSpacing;
  mirror.style.tabSize = style.tabSize;
  clear(mirror);
  // An empty line still takes a row, and an empty box does not.
  for (const row of rows) mirror.append(h("div", {}, [row === "" ? "\u00a0" : row]));
  return [...mirror.children].map((row) => row.getBoundingClientRect().height);
}

function drawGutter(): void {
  const page = parsed();
  clear(gutter);
  const rows = state.page.split("\n");
  const heights = lineHeights(rows);
  for (let i = 0; i < rows.length; i += 1) {
    const tag = page.tags[i] ?? "blank";
    const problem = page.problemAt(i);
    const row = h("div", { class: `gutter-row c-${sketch.tagColor(tag)}` }, [
      h("span", { class: sketch.isHead(tag) ? "bold" : "" }, [sketch.tagLabel(tag)]),
      h("span", { class: "flag c-red bold" }, [problem ? "!" : ""]),
    ]);
    const height = heights?.[i];
    if (height !== undefined) row.style.height = `${height}px`;
    gutter.append(row);
  }
  gutter.scrollTop = pageInput.scrollTop;
}

function drawProblems(): void {
  const page = parsed();
  clear(problems);
  problems.hidden = page.ok();
  for (const problem of page.problems) {
    problems.append(
      h("button", { class: "problem", onclick: () => focusLine(problem.line) }, [
        h("span", { class: "problem-line" }, [`line ${problem.line + 1}`]),
        h("span", {}, [problem.message]),
      ]),
    );
  }
}

function focusLine(index: number): void {
  const rows = state.page.split("\n");
  let at = 0;
  for (let i = 0; i < index && i < rows.length; i += 1) at += (rows[i] as string).length + 1;
  show("page");
  pageInput.focus();
  pageInput.setSelectionRange(at, at + (rows[index] ?? "").length);
  describeCursor();
}

function describeCursor(): void {
  const before = state.page.slice(0, pageInput.selectionStart);
  const index = before.split("\n").length - 1;
  const page = parsed();
  const problem = page.problemAt(index);
  if (problem) {
    say(`line ${index + 1}: ${problem.message}`);
    return;
  }
  const tag = page.tags[index] ?? "blank";
  const said: Record<string, string> = {
    state: "part of the state — what the questions are about",
    rule: "the rule: questions go below it",
    noul: "a yes/no question — the answer is the probability of yes",
    choice: "a choice question — one label out of the set below",
    score: "a score question — a weighted position along the levels",
    raw: "a raw question — sent as the JSON you write",
    criterion: "a criterion — what counts as yes, or as no",
    option: "an option of the choice above",
    level: "a level of the score above",
    model: "the model this request asks for",
    comment: "a comment — never sent",
    json: "part of the raw question's JSON",
    stray: "not placed yet",
    blank: "",
  };
  say(said[tag] ?? "");
}

// ---------------------------------------------------------------- the build tab

function drawCards(): void {
  const page = parsed();
  clear(cards);
  if (document.activeElement !== stateInput) stateInput.value = text(page.state);

  if (!page.ok()) {
    cards.append(
      h("p", { class: "empty" }, [
        "The page has problems, so the questions cannot be read yet. Fix them on the Page tab.",
      ]),
    );
    return;
  }
  const session = page.toSession();
  if (session.questions.length === 0) {
    cards.append(h("p", { class: "empty" }, ["No questions yet — add one below."]));
  }
  session.questions.forEach(([name, question], index) => {
    cards.append(card(session, name, question, index));
  });
}

function commit(session: SessionType): void {
  setPage(sketch.render(session));
}

function field(label: string, value: string, onchange: (value: string) => void): HTMLElement {
  const input = h("input", { type: "text", value, spellcheck: false });
  input.addEventListener("change", () => onchange(input.value));
  return h("label", { class: "field" }, [h("span", {}, [label]), input]);
}

function card(session: SessionType, name: string, question: Question, index: number): HTMLElement {
  const kind = question.kind;
  const body: Node[] = [];

  const rename = (next: string): void => {
    const clean = next.trim();
    if (clean === "" || clean === name) return drawCards();
    const rebuilt = Session.from({
      state: session.state,
      questions: session.questions.map(
        ([n, q]) => [n === name ? clean : n, q] as [string, Question],
      ),
      model: session.model,
    });
    commit(rebuilt);
  };

  body.push(field("name", name, rename));

  if (kind === "noul") {
    body.push(
      field("asks", text(question.instructions), (value) => {
        session.insert(name, noul(value, question.criteria));
        commit(session);
      }),
      field("yes when", text(question.criteria?.yes), (value) => {
        session.insert(name, noul(question.instructions, { ...question.criteria, yes: value }));
        commit(session);
      }),
      field("no when", text(question.criteria?.no), (value) => {
        session.insert(name, noul(question.instructions, { ...question.criteria, no: value }));
        commit(session);
      }),
    );
  } else if (kind === "choice") {
    body.push(
      field("asks", text(question.instructions), (value) => {
        session.insert(name, choice(value, question.options));
        commit(session);
      }),
    );
    question.options.forEach(([label, desc], at) => {
      const replace = (nextLabel: string, nextDesc: string): void => {
        const options: ChoiceOption[] = question.options.map((option, i) =>
          i === at ? ([nextLabel, nextDesc === "" ? null : nextDesc] as ChoiceOption) : option,
        );
        session.insert(name, choice(question.instructions ?? "", options));
        commit(session);
      };
      body.push(
        h("div", { class: "pair" }, [
          field("label", label, (value) => replace(value, text(desc ?? ""))),
          field("means", text(desc ?? ""), (value) => replace(label, value)),
          h(
            "button",
            {
              class: "ghost drop",
              title: "remove this option",
              onclick: () => {
                session.insert(
                  name,
                  choice(
                    question.instructions ?? "",
                    question.options.filter((_, i) => i !== at),
                  ),
                );
                commit(session);
              },
            },
            ["×"],
          ),
        ]),
      );
    });
    body.push(
      h(
        "button",
        {
          class: "ghost",
          onclick: () => {
            session.insert(
              name,
              choice(question.instructions ?? "", [
                ...question.options,
                [`option_${question.options.length + 1}`, null] as ChoiceOption,
              ]),
            );
            commit(session);
          },
        },
        ["+ option"],
      ),
    );
  } else if (kind === "score") {
    body.push(
      field("asks", text(question.instructions), (value) => {
        session.insert(name, score(value, question.levels));
        commit(session);
      }),
    );
    question.levels.forEach((level, at) => {
      body.push(
        h("div", { class: "pair" }, [
          field(`level ${at + 1}`, text(level), (value) => {
            session.insert(
              name,
              score(
                question.instructions ?? "",
                question.levels.map((l, i) => (i === at ? value : l)),
              ),
            );
            commit(session);
          }),
          h(
            "button",
            {
              class: "ghost drop",
              title: "remove this level",
              onclick: () => {
                session.insert(
                  name,
                  score(
                    question.instructions ?? "",
                    question.levels.filter((_, i) => i !== at),
                  ),
                );
                commit(session);
              },
            },
            ["×"],
          ),
        ]),
      );
    });
    body.push(
      h(
        "button",
        {
          class: "ghost",
          onclick: () => {
            session.insert(
              name,
              score(question.instructions ?? "", [
                ...question.levels,
                `level ${question.levels.length + 1}`,
              ]),
            );
            commit(session);
          },
        },
        ["+ level"],
      ),
    );
  } else {
    body.push(h("pre", { class: "raw" }, [compact(question.value)]));
  }

  return h("section", { class: `card k-${kind}` }, [
    h("header", {}, [
      h("span", { class: `pill c-${format.colorFor(kind)}` }, [kind]),
      h("span", { class: "grow" }, []),
      h(
        "button",
        {
          class: "ghost drop",
          title: "remove this question",
          onclick: () => {
            session.remove(name);
            commit(session);
          },
        },
        ["remove"],
      ),
    ]),
    ...body,
    h("p", { class: "hint" }, [`question ${index + 1}`]),
  ]);
}

function addQuestion(kind: "noul" | "choice" | "score"): void {
  const page = parsed();
  if (!page.ok()) {
    say("fix the page's problems first");
    return;
  }
  const session = page.toSession();
  const name = `question_${session.questions.length + 1}`;
  if (kind === "noul") session.insert(name, noul("What this asks"));
  else if (kind === "choice")
    session.insert(name, choice("What this asks", [["first", null] as ChoiceOption]));
  else session.insert(name, score("What this asks", ["low", "high"]));
  commit(session);
}

// ---------------------------------------------------------------- the preview tab

function drawPreview(): void {
  const page = parsed();
  clear(preview);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preview]")) {
    button.classList.toggle("on", button.dataset["preview"] === state.preview);
  }

  if (!page.ok() && state.preview !== "answers") {
    preview.append(h("p", { class: "empty" }, ["The page has problems — nothing to show yet."]));
    return;
  }
  const session = page.toSession();
  const model = modelName(session);

  if (state.preview === "json") {
    preview.append(h("pre", {}, [session.requestJson(model)]));
    return;
  }
  if (state.preview === "ts") {
    preview.append(h("pre", {}, [codegen.typescript(session, model, state.settings.threshold)]));
    return;
  }
  if (state.preview === "rust") {
    preview.append(h("pre", {}, [codegen.rust(session, model, state.settings.threshold)]));
    return;
  }
  if (state.preview === "cost") {
    if (session.questions.length === 0) {
      preview.append(
        h("p", { class: "empty" }, ["Add a question below the --- line to see what a call costs."]),
      );
      return;
    }
    preview.append(
      h("div", { class: "answer" }, [
        styledLines(format.costLines(cost.estimate(session, model), rates(), HOW_TO_PRICE)),
      ]),
    );
    preview.append(
      h("p", { class: "note" }, [
        "Tokens are estimated from the body, not counted by the API's tokenizer — a live answer reports what it actually spent. Rates live in the key dialog.",
      ]),
    );
    return;
  }

  const last = state.last;
  if (!last) {
    preview.append(
      h("p", { class: "empty" }, [
        isLive()
          ? "Ask to send the request and read the answers here."
          : "Ask to simulate the answers offline — deterministic, not predictive.",
      ]),
    );
    return;
  }
  preview.append(
    h("p", { class: "note" }, [
      last.live
        ? `answered live by ${last.model}`
        : `simulated locally as ${last.model} — plausible shapes, no reasoning`,
    ]),
  );
  const spentNote = spent(last, session);
  if (spentNote !== undefined) preview.append(h("p", { class: "note" }, [spentNote]));
  for (const [name, answer] of last.answers) {
    if (!answer) {
      preview.append(h("p", { class: "empty" }, [`${name}: no answer`]));
      continue;
    }
    preview.append(
      h("div", { class: "answer" }, [
        styledLines(format.answerLines(name, answer, state.settings.threshold)),
      ]),
    );
  }
  preview.append(
    h("details", { class: "raw-body" }, [
      h("summary", {}, ["the raw response body"]),
      h("pre", {}, [JSON.stringify(last.raw, null, 2)]),
    ]),
  );
}

/**
 * What the last ask cost: counted from the `usage` a live answer reports, estimated from the page
 * when nothing was sent. Without rates it is tokens only.
 */
function spent(last: Ask, session: SessionType): string | undefined {
  const priced = rates();
  if (last.live) {
    const usage = last.usage ?? {};
    if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
    const money =
      priced === undefined
        ? ""
        : ` · ${cost.usd(cost.price(usage.inputTokens, usage.outputTokens, priced).total)}`;
    return `${usage.inputTokens} in / ${usage.outputTokens} out tokens${money}`;
  }
  const estimate = cost.estimate(session, last.model);
  const money =
    priced === undefined ? "" : ` · ${cost.usd(cost.priceEstimate(estimate, priced).total)}`;
  return `≈ ${estimate.inputTokens} in / ${estimate.outputTokens} out tokens${money} — estimated, since nothing was sent`;
}

function previewText(): string {
  const page = parsed();
  if (!page.ok()) return "";
  const session = page.toSession();
  const model = modelName(session);
  switch (state.preview) {
    case "json":
      return session.requestJson(model);
    case "ts":
      return codegen.typescript(session, model, state.settings.threshold);
    case "rust":
      return codegen.rust(session, model, state.settings.threshold);
    case "cost":
      return linesText(format.costLines(cost.estimate(session, model), rates(), HOW_TO_PRICE));
    case "answers":
      return state.last ? JSON.stringify(state.last.raw, null, 2) : "";
  }
}

// ---------------------------------------------------------------- asking

async function ask(): Promise<void> {
  const page = parsed();
  if (!page.ok()) {
    say("the page has problems — nothing was sent");
    show("page");
    return;
  }
  const session = page.toSession();
  if (session.questions.length === 0) {
    say("no questions yet");
    return;
  }
  const model = modelName(session);
  state.preview = "answers";
  show("preview");

  if (!isLive()) {
    const json = session.questionsJson();
    const answers = session.questions.map(
      ([name]) =>
        [name, mock.answer(session.state, name, json[name] as Json)] as [
          string,
          Answer | undefined,
        ],
    );
    state.last = { model, answers, raw: mock.mockBody(answers, model), live: false };
    say("simulated offline");
    draw();
    return;
  }

  say("asking…");
  draw();
  try {
    const client = new Client({
      apiKey: state.key as string,
      baseUrl: state.settings.baseUrl === "" ? DEFAULT_BASE_URL : state.settings.baseUrl,
      model,
      fetch: window.fetch.bind(window),
    });
    const response = await client.systemOne(session.state, session.questions);
    state.last = {
      model: response.model,
      answers: session.questions.map(
        ([name]) => [name, response.answers.get(name)] as [string, Answer | undefined],
      ),
      raw: response.raw,
      live: true,
      usage: response.usage,
    };
    say(`answered by ${response.model}`);
  } catch (error) {
    state.last = undefined;
    const message = error instanceof Error ? error.message : String(error);
    const blocked = /fetch|network|CORS|Failed to fetch|load failed/i.test(message);
    say(
      blocked
        ? `the browser could not reach the API: ${message} — if this is CORS, the API has to allow this origin, or point the base URL at a proxy that does`
        : message,
    );
  }
  draw();
}

// ---------------------------------------------------------------- the learn tab

/** Lesson commands the terminal answers by printing something this page shows as a tab. */
const PREVIEW_COMMANDS: Readonly<Record<string, PreviewKind>> = {
  ":json": "json",
  ":ts": "ts",
  ":rust": "rust",
  ":cost": "cost",
};

function drawLesson(): void {
  const lesson = LESSONS[state.lesson];
  clear(lessonBox);
  if (!lesson) return;
  lessonBox.append(
    h("p", { class: "count" }, [`lesson ${state.lesson + 1} of ${LESSONS.length}`]),
    h("h2", {}, [lesson.title]),
    ...lesson.body.map((paragraph) => h("p", {}, [paragraph])),
    h("pre", { class: "try" }, [lesson.tryThis]),
    h("div", { class: "row" }, [
      h(
        "button",
        {
          class: "primary",
          onclick: () => {
            const page = parsed();
            if (!page.ok()) {
              say("fix the page's problems first");
              return;
            }
            // A lesson that says `:ask` means the button this page already has.
            if (lesson.tryThis === ":ask") {
              void ask();
              return;
            }
            // A lesson that points at something the terminal prints is a tab over here.
            const tab = PREVIEW_COMMANDS[lesson.tryThis];
            if (tab !== undefined) {
              state.preview = tab;
              show("preview");
              draw();
              return;
            }
            const session = page.toSession();
            const error = applyCommand(session, lesson.tryThis);
            if (error !== undefined) {
              say(error);
              return;
            }
            commit(session);
            say("added to the page");
          },
        },
        ["Try this"],
      ),
      h(
        "button",
        {
          class: "ghost",
          onclick: () => {
            state.lesson = Math.max(0, state.lesson - 1);
            drawLesson();
          },
        },
        ["Back"],
      ),
      h(
        "button",
        {
          class: "ghost",
          onclick: () => {
            state.lesson = Math.min(LESSONS.length - 1, state.lesson + 1);
            drawLesson();
          },
        },
        ["Next"],
      ),
    ]),
  );
}

// ---------------------------------------------------------------- chrome

function show(tab: Tab): void {
  state.tab = tab;
  document.body.dataset["tab"] = tab;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.classList.toggle("on", button.dataset["tab"] === tab);
  }
}

function paint(): void {
  drawGutter();
  drawProblems();
  drawCards();
  drawPreview();
  clear(modePill);
  modePill.append(isLive() ? "live" : "offline");
  // A narrow header has no room for the note; the footer says where the answers come from in full.
  if (!isLive()) modePill.append(h("span", { class: "pill-note" }, [" · simulated"]));
  modePill.className = isLive() ? "pill live" : "pill";
}

let pending = false;

/**
 * Repaint once, after the current event has finished. A form field commits on `change`, which is a
 * blur; rebuilding the cards underneath it there would remove the element the browser is still
 * working on.
 */
function draw(): void {
  if (pending) return;
  pending = true;
  window.setTimeout(() => {
    pending = false;
    paint();
  }, 0);
}

function openSettings(): void {
  el<HTMLInputElement>("key-input").value = state.key ?? "";
  el<HTMLInputElement>("remember-input").checked = state.settings.remember;
  el<HTMLInputElement>("base-input").value = state.settings.baseUrl;
  el<HTMLInputElement>("model-input").value = state.settings.model;
  el<HTMLInputElement>("threshold-input").value = String(state.settings.threshold);
  el<HTMLInputElement>("price-input").value = state.settings.price;
  settingsDialog.showModal();
}

function saveSettingsDialog(): void {
  const key = el<HTMLInputElement>("key-input").value.trim();
  const remember = el<HTMLInputElement>("remember-input").checked;
  const threshold = Number(el<HTMLInputElement>("threshold-input").value);
  const price = el<HTMLInputElement>("price-input").value.trim();
  state.key = key === "" ? undefined : key;
  state.settings = {
    ...state.settings,
    remember,
    baseUrl: el<HTMLInputElement>("base-input").value.trim(),
    model: el<HTMLInputElement>("model-input").value.trim(),
    threshold: Number.isFinite(threshold) ? Math.min(1, Math.max(0, threshold)) : 0.5,
    // Rates that do not parse are dropped rather than kept as a price nobody can read.
    price: price === "" || cost.ratesFromEnv(price) !== undefined ? price : "",
  };
  if (remember && key !== "") rememberKey(key);
  else forgetKey();
  persist();
  settingsDialog.close();
  say(isLive() ? "live mode — requests go to the API" : "offline mode — answers are simulated");
  draw();
}

function wire(): void {
  pageInput.parentElement?.append(mirror);
  // Turning the phone, opening the keyboard, crossing the wrapping width: each changes where the
  // lines break, and the gutter's rows are only right for the width they were measured at.
  new ResizeObserver(() => drawGutter()).observe(pageInput);
  WRAPPED.addEventListener("change", () => drawGutter());

  pageInput.addEventListener("input", () => {
    state.page = pageInput.value;
    persist();
    draw();
    describeCursor();
  });
  pageInput.addEventListener("scroll", () => {
    gutter.scrollTop = pageInput.scrollTop;
  });
  for (const event of ["click", "keyup", "select"]) {
    pageInput.addEventListener(event, describeCursor);
  }
  stateInput.addEventListener("change", () => {
    const page = parsed();
    if (!page.ok()) {
      say("fix the page's problems first");
      return;
    }
    const session = page.toSession();
    session.state = stateInput.value;
    commit(session);
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    button.addEventListener("click", () => show(button.dataset["tab"] as Tab));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-preview]")) {
    button.addEventListener("click", () => {
      state.preview = button.dataset["preview"] as PreviewKind;
      drawPreview();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-add]")) {
    button.addEventListener("click", () =>
      addQuestion(button.dataset["add"] as "noul" | "choice" | "score"),
    );
  }

  el<HTMLButtonElement>("ask").addEventListener("click", () => void ask());
  modePill.addEventListener("click", openSettings);
  el<HTMLButtonElement>("settings-open").addEventListener("click", openSettings);
  el<HTMLButtonElement>("settings-save").addEventListener("click", saveSettingsDialog);
  el<HTMLButtonElement>("settings-close").addEventListener("click", () => settingsDialog.close());
  el<HTMLButtonElement>("settings-forget").addEventListener("click", () => {
    forgetKey();
    state.key = undefined;
    state.settings = { ...state.settings, remember: false };
    persist();
    el<HTMLInputElement>("key-input").value = "";
    el<HTMLInputElement>("remember-input").checked = false;
    say("key forgotten");
    draw();
  });

  const presetSelect = el<HTMLSelectElement>("preset");
  for (const preset of PRESETS) {
    presetSelect.append(h("option", { value: preset.name }, [`${preset.name} — ${preset.about}`]));
  }
  presetSelect.addEventListener("change", () => {
    const preset = PRESETS.find((p) => p.name === presetSelect.value);
    presetSelect.value = "";
    if (!preset) return;
    const session = new Session();
    const error = applyAll(session, preset.script);
    if (error !== undefined) {
      say(error);
      return;
    }
    state.last = undefined;
    commit(session);
    say(`loaded the ${preset.name} preset`);
  });

  el<HTMLButtonElement>("share").addEventListener("click", () => {
    const url = share.link(state.page);
    window.history.replaceState(null, "", url);
    void navigator.clipboard
      ?.writeText(url)
      .then(() => say("link copied — the page travels in it, the key never does"))
      .catch(() => say("the link is in the address bar"));
  });
  el<HTMLButtonElement>("copy").addEventListener("click", () => {
    const body = previewText();
    if (body === "") {
      say("nothing to copy yet");
      return;
    }
    void navigator.clipboard
      ?.writeText(body)
      .then(() => say("copied"))
      .catch(() => say("could not reach the clipboard"));
  });

  document.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void ask();
    }
  });
}

export function boot(): void {
  const stored = loadSettings();
  state.settings = stored;
  state.key = stored.remember ? loadKey() : undefined;
  const shared = share.fromLocation();
  state.page = shared ?? (stored.page === "" ? START : stored.page);
  pageInput.value = state.page;

  wire();
  drawLesson();
  show("page");
  paint();
  say(
    isLive()
      ? "live mode — requests go to the API"
      : "offline — answers are simulated on this device",
  );
}
