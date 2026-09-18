/**
 * Builder mode: compose a question in a form instead of a one-line command, with the JSON it will
 * send rendered beside it as you type.
 */

import type { Json, JsonObject } from "../json.js";
import type { ChoiceOption, Question } from "../typesafe/questions.js";
import {
  choice as makeChoice,
  noul as makeNoul,
  score as makeScore,
} from "../typesafe/questions.js";
import type { KeyEvent } from "../tui/keys.js";
import { isCtrl } from "../tui/keys.js";
import { value } from "./session.js";

export type Kind = "noul" | "choice" | "score";

const KINDS: readonly Kind[] = ["noul", "choice", "score"];

export function kindAbout(kind: Kind): string {
  switch (kind) {
    case "noul":
      return "probability that the statement is true (0–1)";
    case "choice":
      return "one label out of the set you define";
    case "score":
      return "a weighted position along ordered levels";
  }
}

/** Which widget the keyboard is on. */
export type Field =
  | { kind: "state" }
  | { kind: "name" }
  | { kind: "type" }
  | { kind: "instructions" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "optionLabel"; index: number }
  | { kind: "optionDesc"; index: number }
  | { kind: "level"; index: number };

export function sameField(a: Field, b: Field): boolean {
  if (a.kind !== b.kind) return false;
  return "index" in a && "index" in b ? a.index === b.index : true;
}

/** What the app should do after a key press. */
export type Outcome =
  | { kind: "open" }
  | { kind: "cancel" }
  | { kind: "commit"; name: string; question: Question; state: string };

export class Builder {
  state: string;
  name: string;
  kind: Kind = "noul";
  instructions = "";
  yes = "";
  no = "";
  options: Array<[string, string]> = [
    ["", ""],
    ["", ""],
  ];
  levels: string[] = ["", "", ""];
  focus: number;
  cursor: number;
  message: string | undefined;

  /**
   * Opens on the first field that still needs an answer: the state if there is none, the name if
   * there is no name, otherwise the type.
   */
  constructor(state: string, name: string) {
    this.state = state;
    this.name = name;
    this.focus = name !== "" ? 2 : state.trim() === "" ? 0 : 1;
    this.cursor = this.focus === 0 ? [...state].length : [...name].length;
  }

  /** The focusable fields, in tab order, for the current question type. */
  fields(): Field[] {
    const f: Field[] = [
      { kind: "state" },
      { kind: "name" },
      { kind: "type" },
      { kind: "instructions" },
    ];
    if (this.kind === "noul") {
      f.push({ kind: "yes" }, { kind: "no" });
    } else if (this.kind === "choice") {
      this.options.forEach((_, index) => {
        f.push({ kind: "optionLabel", index }, { kind: "optionDesc", index });
      });
    } else {
      this.levels.forEach((_, index) => f.push({ kind: "level", index }));
    }
    return f;
  }

  focused(): Field {
    const fields = this.fields();
    return fields[Math.min(this.focus, fields.length - 1)] as Field;
  }

  text(field: Field): string {
    switch (field.kind) {
      case "state":
        return this.state;
      case "name":
        return this.name;
      case "instructions":
        return this.instructions;
      case "yes":
        return this.yes;
      case "no":
        return this.no;
      case "optionLabel":
        return this.options[field.index]?.[0] ?? "";
      case "optionDesc":
        return this.options[field.index]?.[1] ?? "";
      case "level":
        return this.levels[field.index] ?? "";
      case "type":
        return this.kind;
    }
  }

  #setText(field: Field, text: string): void {
    switch (field.kind) {
      case "state":
        this.state = text;
        break;
      case "name":
        this.name = text;
        break;
      case "instructions":
        this.instructions = text;
        break;
      case "yes":
        this.yes = text;
        break;
      case "no":
        this.no = text;
        break;
      case "optionLabel": {
        const row = this.options[field.index];
        if (row) row[0] = text;
        break;
      }
      case "optionDesc": {
        const row = this.options[field.index];
        if (row) row[1] = text;
        break;
      }
      case "level":
        if (field.index < this.levels.length) this.levels[field.index] = text;
        break;
      case "type":
        break;
    }
  }

  key(event: KeyEvent): Outcome {
    this.message = undefined;
    const { code } = event;

    if (code.kind === "esc") return { kind: "cancel" };
    if (isCtrl(event, "s")) return this.#commit();
    if (isCtrl(event, "x")) {
      this.deleteRow();
      return { kind: "open" };
    }
    if (isCtrl(event, "o")) {
      this.addRow();
      return { kind: "open" };
    }

    const onType = this.focused().kind === "type";
    switch (code.kind) {
      case "tab":
        this.#moveFocus(event.shift ? -1 : 1);
        break;
      case "backtab":
        this.#moveFocus(-1);
        break;
      case "down":
        this.#moveFocus(1);
        break;
      case "up":
        this.#moveFocus(-1);
        break;
      case "enter":
        if (this.#onLastRow()) this.addRow();
        this.#moveFocus(1);
        break;
      case "left":
        if (onType) this.#setKind(prevKind(this.kind));
        else this.cursor = Math.max(0, this.cursor - 1);
        break;
      case "right":
        if (onType) this.#setKind(nextKind(this.kind));
        else this.cursor = Math.min(this.cursor + 1, this.#len());
        break;
      case "home":
        this.cursor = 0;
        break;
      case "end":
        this.cursor = this.#len();
        break;
      case "backspace":
        if (this.cursor > 0) {
          const at = this.cursor - 1;
          this.cursor = at;
          this.#remove(at);
        }
        break;
      case "delete":
        this.#remove(this.cursor);
        break;
      case "char": {
        const c = code.char;
        if (onType) {
          if (c === " ") this.#setKind(nextKind(this.kind));
          else if (c === "n" || c === "N") this.#setKind("noul");
          else if (c === "c" || c === "C") this.#setKind("choice");
          else if (c === "s" || c === "S") this.#setKind("score");
        } else if (!event.ctrl && !event.alt) {
          this.#insert(c);
        }
        break;
      }
      default:
        break;
    }
    return { kind: "open" };
  }

  #setKind(kind: Kind): void {
    this.kind = kind;
    this.focus = Math.min(this.focus, this.fields().length - 1);
  }

  #moveFocus(delta: number): void {
    const len = this.fields().length;
    this.focus = (((this.focus + delta) % len) + len) % len;
    this.cursor = this.#len();
  }

  #len(): number {
    return [...this.text(this.focused())].length;
  }

  #insert(c: string): void {
    const field = this.focused();
    if (field.kind === "type") return;
    const chars = [...this.text(field)];
    chars.splice(this.cursor, 0, c);
    this.#setText(field, chars.join(""));
    this.cursor += 1;
  }

  #remove(index: number): void {
    const field = this.focused();
    if (field.kind === "type") return;
    const chars = [...this.text(field)];
    if (index >= chars.length) return;
    chars.splice(index, 1);
    this.#setText(field, chars.join(""));
  }

  #onLastRow(): boolean {
    const field = this.focused();
    if (field.kind === "optionDesc") return field.index + 1 === this.options.length;
    if (field.kind === "level") return field.index + 1 === this.levels.length;
    return false;
  }

  /** Ctrl-O, or Enter on the last row: one more option or level. */
  addRow(): void {
    if (this.kind === "choice") this.options.push(["", ""]);
    else if (this.kind === "score") this.levels.push("");
    else this.message = "A noul has only `yes` and `no`.";
  }

  /** Ctrl-X: drop the row the cursor is on. */
  deleteRow(): void {
    const field = this.focused();
    if ((field.kind === "optionLabel" || field.kind === "optionDesc") && this.options.length > 1) {
      this.options.splice(field.index, 1);
    } else if (field.kind === "level" && this.levels.length > 1) {
      this.levels.splice(field.index, 1);
    } else {
      this.message = "Nothing to remove here.";
    }
    this.focus = Math.min(this.focus, this.fields().length - 1);
    this.cursor = this.#len();
  }

  /** The question as it would go on the wire right now, incomplete parts included. */
  preview(): Json {
    const q: JsonObject = { type: this.kind };
    if (this.instructions.trim() !== "") q["instructions"] = value(this.instructions);
    if (this.kind === "noul") {
      const criteria: JsonObject = {};
      if (this.yes.trim() !== "") criteria["true"] = value(this.yes);
      if (this.no.trim() !== "") criteria["false"] = value(this.no);
      if (Object.keys(criteria).length > 0) q["criteria"] = criteria;
    } else if (this.kind === "choice") {
      const criteria: JsonObject = {};
      for (const [label, desc] of this.options) {
        if (label.trim() === "") continue;
        criteria[label.trim()] = desc.trim() === "" ? null : value(desc);
      }
      q["criteria"] = criteria;
    } else {
      q["criteria"] = this.levels.filter((l) => l.trim() !== "").map((l) => value(l));
    }
    const name = this.name.trim() === "" ? "<name>" : this.name.trim();
    return { [name]: q };
  }

  /** The equivalent one-line command, so builder mode teaches the fast path. */
  asCommand(): string {
    const name = this.name.trim() === "" ? "<name>" : this.name.trim();
    const instructions = this.instructions.trim();
    if (this.kind === "noul") {
      let s = `:noul ${name} ${instructions}`;
      if (this.yes.trim() !== "") s += ` | yes: ${this.yes.trim()}`;
      if (this.no.trim() !== "") s += ` | no: ${this.no.trim()}`;
      return s;
    }
    if (this.kind === "choice") {
      let s = `:choice ${name} ${instructions}`;
      for (const [label, desc] of this.options) {
        if (label.trim() === "") continue;
        s += ` | ${label.trim()}`;
        if (desc.trim() !== "") s += `=${desc.trim()}`;
      }
      return s;
    }
    let s = `:score ${name} ${instructions}`;
    for (const level of this.levels) {
      if (level.trim() !== "") s += ` | ${level.trim()}`;
    }
    return s;
  }

  #commit(): Outcome {
    const name = this.name.trim();
    if (name === "") {
      this.message = "Every question needs a name — answers come back under it.";
      return { kind: "open" };
    }
    if (name.split(/\s+/).length > 1) {
      this.message = "Names cannot contain spaces.";
      return { kind: "open" };
    }
    const instructions = this.instructions.trim();
    if (instructions === "") {
      this.message = "Instructions are what the model actually reads.";
      return { kind: "open" };
    }
    let question: Question;
    if (this.kind === "noul") {
      question = makeNoul(value(instructions), {
        yes: this.yes.trim() === "" ? undefined : value(this.yes),
        no: this.no.trim() === "" ? undefined : value(this.no),
      });
    } else if (this.kind === "choice") {
      const options: ChoiceOption[] = this.options
        .filter(([label]) => label.trim() !== "")
        .map(([label, desc]) => [label.trim(), desc.trim() === "" ? null : value(desc)] as const);
      if (options.length < 2) {
        this.message = "A choice needs at least two options.";
        return { kind: "open" };
      }
      question = makeChoice(value(instructions), options);
    } else {
      const levels = this.levels.filter((l) => l.trim() !== "").map((l) => value(l));
      if (levels.length < 2) {
        this.message = "A score needs at least two ordered levels.";
        return { kind: "open" };
      }
      question = makeScore(value(instructions), levels);
    }
    return { kind: "commit", name, question, state: this.state };
  }
}

function nextKind(kind: Kind): Kind {
  return KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length] as Kind;
}

function prevKind(kind: Kind): Kind {
  return KINDS[(KINDS.indexOf(kind) + KINDS.length - 1) % KINDS.length] as Kind;
}
