/** Turning what the terminal writes on stdin into key events. */

export type KeyCode =
  | { kind: "char"; char: string }
  | { kind: "enter" }
  | { kind: "tab" }
  | { kind: "backtab" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "pageUp" }
  | { kind: "pageDown" }
  | { kind: "esc" };

export interface KeyEvent {
  code: KeyCode;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export function key(code: KeyCode, modifiers: Partial<Omit<KeyEvent, "code">> = {}): KeyEvent {
  return { code, ctrl: false, alt: false, shift: false, ...modifiers };
}

export const char = (c: string, modifiers?: Partial<Omit<KeyEvent, "code">>): KeyEvent =>
  key({ kind: "char", char: c }, modifiers);
export const ctrl = (c: string): KeyEvent => char(c, { ctrl: true });

/** Is this key `Ctrl-<c>`? */
export function isCtrl(event: KeyEvent, c: string): boolean {
  return event.ctrl && event.code.kind === "char" && event.code.char === c;
}

const ESC = "\u001b";

/** `1;5A`-style parameters: the trailing number carries the modifiers. */
function modifiers(params: string): Partial<Omit<KeyEvent, "code">> {
  const parts = params.split(";");
  const raw = Number(parts[1] ?? "1");
  if (!Number.isFinite(raw) || raw < 1) return {};
  const bits = raw - 1;
  return { shift: (bits & 1) !== 0, alt: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
}

const FINAL_CODES: Record<string, KeyCode> = {
  A: { kind: "up" },
  B: { kind: "down" },
  C: { kind: "right" },
  D: { kind: "left" },
  H: { kind: "home" },
  F: { kind: "end" },
  Z: { kind: "backtab" },
};

const TILDE_CODES: Record<string, KeyCode> = {
  "1": { kind: "home" },
  "3": { kind: "delete" },
  "4": { kind: "end" },
  "5": { kind: "pageUp" },
  "6": { kind: "pageDown" },
  "7": { kind: "home" },
  "8": { kind: "end" },
};

/**
 * Decode one key from the front of `input`.
 *
 * Returns the event and how many characters it consumed, or `undefined` when the input so far is
 * the start of a longer escape sequence and the rest has not arrived yet.
 */
export function decodeOne(input: string): { event: KeyEvent; consumed: number } | undefined {
  if (input.length === 0) return undefined;
  const first = input[0] as string;

  if (first === ESC) {
    if (input.length === 1) return { event: key({ kind: "esc" }), consumed: 1 };
    const second = input[1] as string;
    // CSI: ESC [ params final
    if (second === "[") {
      let i = 2;
      let params = "";
      while (i < input.length && /[0-9;?]/.test(input[i] as string)) {
        params += input[i];
        i += 1;
      }
      if (i >= input.length) return undefined;
      const final = input[i] as string;
      const consumed = i + 1;
      if (final === "~") {
        const code = TILDE_CODES[params.split(";")[0] ?? ""];
        if (!code) return { event: key({ kind: "esc" }), consumed };
        return { event: key(code, modifiers(params)), consumed };
      }
      const code = FINAL_CODES[final];
      if (code) {
        const mods = final === "Z" ? { shift: true } : modifiers(params);
        return { event: key(code, mods), consumed };
      }
      // An escape sequence this REPL has no use for (mouse, focus, bracketed paste markers).
      return { event: key({ kind: "esc" }), consumed };
    }
    // SS3: ESC O final
    if (second === "O") {
      if (input.length < 3) return undefined;
      const code = FINAL_CODES[input[2] as string];
      return { event: key(code ?? { kind: "esc" }), consumed: 3 };
    }
    // ESC <key> is Alt-<key>.
    const rest = decodeOne(input.slice(1));
    if (!rest) return { event: key({ kind: "esc" }), consumed: 1 };
    return {
      event: { ...rest.event, alt: true },
      consumed: rest.consumed + 1,
    };
  }

  if (first === "\r" || first === "\n") return { event: key({ kind: "enter" }), consumed: 1 };
  if (first === "\t") return { event: key({ kind: "tab" }), consumed: 1 };
  if (first === "\u007f" || first === "\b")
    return { event: key({ kind: "backspace" }), consumed: 1 };

  // Read the whole code point: an astral character is one key but two UTF-16 units.
  const code = input.codePointAt(0) ?? 0;
  if (code < 0x20) {
    // Ctrl-A is 0x01, and so on up to Ctrl-Z.
    return { event: ctrl(String.fromCharCode(code + 96)), consumed: 1 };
  }
  const point = String.fromCodePoint(code);
  return { event: char(point), consumed: point.length };
}

/** Feed terminal bytes in, get key events out, keeping any half-arrived escape sequence. */
export class KeyDecoder {
  #pending = "";

  push(input: string): KeyEvent[] {
    this.#pending += input;
    const events: KeyEvent[] = [];
    while (this.#pending.length > 0) {
      // A lone Esc may be the start of a sequence whose rest has not arrived; `flush` decides.
      if (this.#pending === ESC) break;
      const next = decodeOne(this.#pending);
      if (!next) break;
      events.push(next.event);
      this.#pending = this.#pending.slice(next.consumed);
    }
    return events;
  }

  /** Whether a partial sequence is waiting for the rest of its bytes. */
  get pending(): boolean {
    return this.#pending.length > 0;
  }

  /** Decode whatever is left — a lone Esc that turned out not to start a sequence. */
  flush(): KeyEvent[] {
    const events: KeyEvent[] = [];
    while (this.#pending.length > 0) {
      const next = decodeOne(this.#pending);
      if (!next) {
        this.#pending = "";
        break;
      }
      events.push(next.event);
      this.#pending = this.#pending.slice(next.consumed);
    }
    return events;
  }
}
