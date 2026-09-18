/** Raw mode, the alternate screen, and pushing a rendered buffer at the terminal. */

import { Buffer } from "./buffer.js";
import type { KeyEvent } from "./keys.js";
import { KeyDecoder } from "./keys.js";

const ESC = "\u001b";
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const LEAVE_ALT_SCREEN = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const CLEAR = `${ESC}[2J`;
const NO_WRAP = `${ESC}[?7l`;
const WRAP = `${ESC}[?7h`;
const RESET = `${ESC}[0m`;

/** Where the terminal's own cursor should sit after a frame. */
export interface CursorPosition {
  x: number;
  y: number;
}

export interface TerminalOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** How long a lone Esc waits for the rest of a possible escape sequence. */
  escDelayMs?: number;
}

export class Terminal {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;
  readonly #decoder = new KeyDecoder();
  readonly #escDelayMs: number;
  #onKey: ((event: KeyEvent) => void) | undefined;
  #onResize: (() => void) | undefined;
  #escTimer: NodeJS.Timeout | undefined;
  #started = false;
  #lastFrame = "";

  constructor(options: TerminalOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
    this.#escDelayMs = options.escDelayMs ?? 30;
  }

  /** A terminal that reports no size (a pty opened without one) still gets a usable frame. */
  get width(): number {
    const columns = this.#output.columns;
    return columns !== undefined && columns > 0 ? columns : 80;
  }

  get height(): number {
    const rows = this.#output.rows;
    return rows !== undefined && rows > 0 ? rows : 24;
  }

  /** A buffer the size of the terminal, ready to draw into. */
  frame(): Buffer {
    return new Buffer(this.width, this.height);
  }

  start(onKey: (event: KeyEvent) => void, onResize?: () => void): void {
    if (this.#started) return;
    this.#started = true;
    this.#onKey = onKey;
    this.#onResize = onResize;
    // Auto-wrap off: writing the bottom-right cell must not scroll the frame away.
    this.#output.write(ENTER_ALT_SCREEN + CLEAR + NO_WRAP + HIDE_CURSOR);
    if (this.#input.isTTY) this.#input.setRawMode(true);
    this.#input.setEncoding("utf8");
    this.#input.resume();
    this.#input.on("data", this.#handleData);
    this.#output.on("resize", this.#handleResize);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    clearTimeout(this.#escTimer);
    this.#input.off("data", this.#handleData);
    this.#output.off("resize", this.#handleResize);
    if (this.#input.isTTY) this.#input.setRawMode(false);
    this.#input.pause();
    this.#output.write(RESET + WRAP + SHOW_CURSOR + LEAVE_ALT_SCREEN);
  }

  /** Draw a frame, optionally leaving the cursor somewhere visible. */
  draw(buffer: Buffer, cursor?: CursorPosition): void {
    const body = buffer.toAnsi();
    // Terminals flicker when a frame is repainted for nothing.
    const cursorPart = cursor
      ? `${ESC}[${cursor.y + 1};${cursor.x + 1}H${SHOW_CURSOR}`
      : HIDE_CURSOR;
    const frame = body + cursorPart;
    if (frame === this.#lastFrame) return;
    this.#lastFrame = frame;
    this.#output.write(HIDE_CURSOR + body + cursorPart);
  }

  readonly #handleData = (chunk: string | Uint8Array): void => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    clearTimeout(this.#escTimer);
    for (const event of this.#decoder.push(text)) this.#onKey?.(event);
    if (this.#decoder.pending) {
      this.#escTimer = setTimeout(() => {
        for (const event of this.#decoder.flush()) this.#onKey?.(event);
      }, this.#escDelayMs);
      this.#escTimer.unref?.();
    }
  };

  readonly #handleResize = (): void => {
    this.#lastFrame = "";
    this.#onResize?.();
  };
}
