/**
 * Sketch mode: a small text editor over one page of sketch notation. The page is parsed on every
 * keystroke, so the gutter and the preview pane always show what the text currently means.
 */

import type { KeyEvent } from "../tui/keys.js";
import { isCtrl } from "../tui/keys.js";
import type { ParsedSketch } from "./sketch.js";
import { parse } from "./sketch.js";

/** What the right-hand pane shows next to the page. */
export type Preview = "json" | "answers" | "ts" | "cost";

export const PREVIEWS: readonly Preview[] = ["json", "answers", "ts", "cost"];

function nextPreview(preview: Preview): Preview {
  const at = PREVIEWS.indexOf(preview);
  return PREVIEWS[(at + 1) % PREVIEWS.length] as Preview;
}

/** What the app should do after a key press. */
export type Outcome =
  /** Stay open. */
  | "open"
  /** Close without touching the session. */
  | "cancel"
  /** Replace the session with the page. */
  | "apply"
  /** Replace the session with the page, then send it. */
  | "applyAndAsk";

export class Editor {
  lines: string[];
  row = 0;
  /** Column as a character index into the current line. */
  col = 0;
  /** First visible row; the UI adjusts it to keep the cursor in view. */
  top = 0;
  preview: Preview = "json";
  dirty = false;
  message: string | undefined;
  /** Esc on a dirty page asks once before discarding it. */
  #escArmed = false;
  /** The last line cut with Ctrl-X, ready for Ctrl-U. */
  #cut: string | undefined;

  constructor(text: string) {
    this.lines = text.split("\n");
  }

  text(): string {
    return this.lines.join("\n");
  }

  parsed(): ParsedSketch {
    return parse(this.text());
  }

  key(event: KeyEvent): Outcome {
    this.message = undefined;
    const armed = this.#escArmed;
    this.#escArmed = false;
    const { code, ctrl, alt } = event;

    if (code.kind === "esc") {
      if (this.dirty && !armed) {
        this.#escArmed = true;
        this.message = "unapplied edits — Esc again discards them, ^S applies";
        return "open";
      }
      return "cancel";
    }
    if (isCtrl(event, "s")) return "apply";
    if (isCtrl(event, "g")) return "applyAndAsk";
    if (isCtrl(event, "p")) {
      this.preview = nextPreview(this.preview);
      return "open";
    }
    if (isCtrl(event, "x")) {
      this.#cutLine();
      return "open";
    }
    if (isCtrl(event, "u")) {
      this.#pasteLine();
      return "open";
    }
    if (isCtrl(event, "a")) {
      this.col = 0;
      return "open";
    }
    if (isCtrl(event, "e")) {
      this.col = this.#len();
      return "open";
    }

    switch (code.kind) {
      case "up":
        if (alt) this.#swap(-1);
        else this.#vertical(-1);
        break;
      case "down":
        if (alt) this.#swap(1);
        else this.#vertical(1);
        break;
      case "pageUp":
        this.#vertical(-10);
        break;
      case "pageDown":
        this.#vertical(10);
        break;
      case "left":
        if (this.col > 0) this.col -= 1;
        else if (this.row > 0) {
          this.row -= 1;
          this.col = this.#len();
        }
        break;
      case "right":
        if (this.col < this.#len()) this.col += 1;
        else if (this.row + 1 < this.lines.length) {
          this.row += 1;
          this.col = 0;
        }
        break;
      case "home":
        this.col = 0;
        break;
      case "end":
        this.col = this.#len();
        break;
      case "enter":
        this.#newline();
        break;
      case "tab":
        this.insertStr("  ");
        break;
      case "backspace":
        this.#backspace();
        break;
      case "delete":
        this.#delete();
        break;
      case "char":
        if (!ctrl && !alt) this.#insert(code.char);
        break;
      default:
        break;
    }
    return "open";
  }

  #len(): number {
    return [...(this.lines[this.row] ?? "")].length;
  }

  #vertical(delta: number): void {
    const last = this.lines.length - 1;
    this.row = Math.min(last, Math.max(0, this.row + delta));
    this.col = Math.min(this.col, this.#len());
  }

  #insert(c: string): void {
    const chars = [...(this.lines[this.row] ?? "")];
    chars.splice(this.col, 0, c);
    this.lines[this.row] = chars.join("");
    this.col += 1;
    this.dirty = true;
  }

  insertStr(s: string): void {
    for (const c of s) this.#insert(c);
  }

  /** Split the line at the cursor; the new line keeps the indentation of the one above. */
  #newline(): void {
    const chars = [...(this.lines[this.row] ?? "")];
    const head = chars.slice(0, this.col).join("");
    const tail = chars.slice(this.col).join("");
    this.lines[this.row] = head;
    const leading = /^\s*/.exec(head)?.[0] ?? "";
    const indent = tail.trim() === "" && head.trim() === "" ? "" : leading;
    this.row += 1;
    this.col = [...indent].length;
    this.lines.splice(this.row, 0, `${indent}${tail}`);
    this.dirty = true;
  }

  #backspace(): void {
    if (this.col > 0) {
      const chars = [...(this.lines[this.row] ?? "")];
      chars.splice(this.col - 1, 1);
      this.lines[this.row] = chars.join("");
      this.col -= 1;
      this.dirty = true;
    } else if (this.row > 0) {
      const [removed] = this.lines.splice(this.row, 1);
      this.row -= 1;
      this.col = this.#len();
      this.lines[this.row] = `${this.lines[this.row] ?? ""}${removed ?? ""}`;
      this.dirty = true;
    }
  }

  #delete(): void {
    if (this.col < this.#len()) {
      const chars = [...(this.lines[this.row] ?? "")];
      chars.splice(this.col, 1);
      this.lines[this.row] = chars.join("");
      this.dirty = true;
    } else if (this.row + 1 < this.lines.length) {
      const [next] = this.lines.splice(this.row + 1, 1);
      this.lines[this.row] = `${this.lines[this.row] ?? ""}${next ?? ""}`;
      this.dirty = true;
    }
  }

  /** Ctrl-X: take the current line out; Ctrl-U puts it back wherever the cursor is. */
  #cutLine(): void {
    if (this.lines.length === 1) {
      this.#cut = this.lines[0] ?? "";
      this.lines[0] = "";
    } else {
      this.#cut = this.lines.splice(this.row, 1)[0] ?? "";
    }
    this.row = Math.min(this.row, this.lines.length - 1);
    this.col = Math.min(this.col, this.#len());
    this.dirty = true;
    this.message = "line cut — ^U pastes it above the cursor";
  }

  #pasteLine(): void {
    if (this.#cut === undefined) {
      this.message = "nothing cut yet — ^X cuts the current line";
      return;
    }
    this.lines.splice(this.row, 0, this.#cut);
    this.row += 1;
    this.dirty = true;
  }

  /** Alt-Up / Alt-Down: move the current line, which is how questions and levels get reordered. */
  #swap(delta: number): void {
    const target = this.row + delta;
    if (target < 0 || target >= this.lines.length) return;
    const current = this.lines[this.row] as string;
    this.lines[this.row] = this.lines[target] as string;
    this.lines[target] = current;
    this.row = target;
    this.dirty = true;
  }
}
