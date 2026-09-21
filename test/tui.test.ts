/** The terminal layer: keys in, cells out. */

import { describe, expect, it } from "vitest";

import { Buffer } from "../src/tui/buffer.js";
import { char, decodeOne, key, KeyDecoder } from "../src/tui/keys.js";
import type { KeyEvent } from "../src/tui/keys.js";
import {
  isDeleteWordLeft,
  isWordLeft,
  isWordRight,
  wordLeft,
  wordRight,
} from "../src/tui/words.js";
import { horizontal, length, min, percentage, solve, vertical } from "../src/tui/layout.js";
import { blankLine, line, sgr, span } from "../src/tui/style.js";

const ESC = "\u001b";

function decode(input: string): KeyEvent[] {
  return new KeyDecoder().push(input);
}

describe("key decoding", () => {
  it("reads plain characters", () => {
    expect(decode("ab")).toEqual([
      { code: { kind: "char", char: "a" }, ctrl: false, alt: false, shift: false },
      { code: { kind: "char", char: "b" }, ctrl: false, alt: false, shift: false },
    ]);
  });

  it("reads control characters", () => {
    const [event] = decode("\u0003");
    expect(event).toMatchObject({ code: { kind: "char", char: "c" }, ctrl: true });
    expect(decode("\r")[0]?.code.kind).toBe("enter");
    expect(decode("\t")[0]?.code.kind).toBe("tab");
    expect(decode("\u007f")[0]?.code.kind).toBe("backspace");
  });

  it("reads the arrow, navigation and function sequences", () => {
    expect(decode(`${ESC}[A`)[0]?.code.kind).toBe("up");
    expect(decode(`${ESC}[B`)[0]?.code.kind).toBe("down");
    expect(decode(`${ESC}OC`)[0]?.code.kind).toBe("right");
    expect(decode(`${ESC}[3~`)[0]?.code.kind).toBe("delete");
    expect(decode(`${ESC}[5~`)[0]?.code.kind).toBe("pageUp");
    expect(decode(`${ESC}[6~`)[0]?.code.kind).toBe("pageDown");
    expect(decode(`${ESC}[H`)[0]?.code.kind).toBe("home");
    expect(decode(`${ESC}[F`)[0]?.code.kind).toBe("end");
    expect(decode(`${ESC}[Z`)[0]).toMatchObject({ code: { kind: "backtab" }, shift: true });
  });

  it("reads modified arrows", () => {
    expect(decode(`${ESC}[1;3A`)[0]).toMatchObject({ code: { kind: "up" }, alt: true });
    expect(decode(`${ESC}[1;5D`)[0]).toMatchObject({ code: { kind: "left" }, ctrl: true });
    expect(decode(`${ESC}b`)[0]).toMatchObject({ code: { kind: "char", char: "b" }, alt: true });
  });

  it("reads Alt-arrow however the terminal spells it", () => {
    // Meta rather than Alt: the same keypress, a different modifier bit.
    expect(decode(`${ESC}[1;9A`)[0]).toMatchObject({ code: { kind: "up" }, alt: true });
    expect(decode(`${ESC}[1;13D`)[0]).toMatchObject({
      code: { kind: "left" },
      alt: true,
      ctrl: true,
    });
    // Alt as an Esc prefix on a whole arrow sequence.
    expect(decode(`${ESC}${ESC}[B`)[0]).toMatchObject({ code: { kind: "down" }, alt: true });
    // SS3, with the modifier alone and as a CSI-style pair.
    expect(decode(`${ESC}O3D`)[0]).toMatchObject({ code: { kind: "left" }, alt: true });
    expect(decode(`${ESC}O1;3C`)[0]).toMatchObject({ code: { kind: "right" }, alt: true });
  });

  it("waits for the arrow behind a doubled Esc", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}${ESC}`)).toEqual([]);
    expect(decoder.pending).toBe(true);
    expect(decoder.push("[A")[0]).toMatchObject({ code: { kind: "up" }, alt: true });
    expect(decoder.pending).toBe(false);
    // Nothing follows: it was Alt-Esc after all.
    const lone = new KeyDecoder();
    expect(lone.push(`${ESC}${ESC}`)).toEqual([]);
    expect(lone.flush()[0]).toMatchObject({ code: { kind: "esc" }, alt: true });
  });

  it("holds a lone Esc until it is clear no sequence follows", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(ESC)).toEqual([]);
    expect(decoder.pending).toBe(true);
    expect(decoder.flush()[0]?.code.kind).toBe("esc");
    expect(decoder.pending).toBe(false);
  });

  it("waits for the rest of a split sequence", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push(`${ESC}[`)).toEqual([]);
    expect(decoder.push("A")[0]?.code.kind).toBe("up");
  });

  it("consumes exactly what it decoded", () => {
    expect(decodeOne(`${ESC}[1;5A`)?.consumed).toBe(6);
    expect(decodeOne(`${ESC}${ESC}[1;5A`)?.consumed).toBe(7);
    // A half-arrived sequence consumes nothing until it is clear no more is coming; then the
    // doubled Esc is the Alt-Esc it turned out to be.
    expect(decodeOne(`${ESC}${ESC}`)).toBeUndefined();
    expect(decodeOne(`${ESC}${ESC}`, true)?.consumed).toBe(2);
    expect(decodeOne("x")?.consumed).toBe(1);
    // An astral character is one key, two UTF-16 units.
    expect(decodeOne("\u{1f600}")).toMatchObject({ consumed: 2 });
  });
});

describe("word motion", () => {
  const chars = [..."  the payout failed"];

  it("crosses one word at a time", () => {
    expect(wordLeft(chars, chars.length)).toBe(13);
    expect(wordLeft(chars, 13)).toBe(6);
    expect(wordLeft(chars, 6)).toBe(2);
    expect(wordLeft(chars, 2)).toBe(0);
    expect(wordLeft(chars, 0)).toBe(0);

    expect(wordRight(chars, 0)).toBe(5);
    expect(wordRight(chars, 5)).toBe(12);
    expect(wordRight(chars, 12)).toBe(chars.length);
    expect(wordRight(chars, chars.length)).toBe(chars.length);
  });

  it("answers to every spelling of Alt-arrow", () => {
    expect(isWordLeft(key({ kind: "left" }, { alt: true }))).toBe(true);
    expect(isWordLeft(key({ kind: "left" }, { ctrl: true }))).toBe(true);
    expect(isWordLeft(char("b", { alt: true }))).toBe(true);
    expect(isWordRight(key({ kind: "right" }, { alt: true }))).toBe(true);
    expect(isWordRight(char("f", { alt: true }))).toBe(true);
    expect(isDeleteWordLeft(key({ kind: "backspace" }, { alt: true }))).toBe(true);

    expect(isWordLeft(key({ kind: "left" }))).toBe(false);
    expect(isWordRight(char("f"))).toBe(false);
    expect(isDeleteWordLeft(key({ kind: "backspace" }))).toBe(false);
  });
});

describe("layout", () => {
  it("gives the leftovers to the flexible segment", () => {
    expect(solve(100, [length(1), min(3), length(3)])).toEqual([1, 96, 3]);
    expect(solve(80, [min(40), length(36)])).toEqual([44, 36]);
    expect(solve(100, [percentage(56), length(2), min(24)])).toEqual([56, 2, 42]);
  });

  it("never overflows, even in a tiny area", () => {
    for (const total of [0, 1, 2, 3, 5, 10]) {
      const sizes = solve(total, [length(1), min(3), length(3)]);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(total);
      expect(sizes.every((s) => s >= 0)).toBe(true);
    }
  });

  it("lays rectangles out end to end", () => {
    const [top, body] = vertical({ x: 0, y: 0, width: 10, height: 5 }, [length(1), min(1)]);
    expect(top).toEqual({ x: 0, y: 0, width: 10, height: 1 });
    expect(body).toEqual({ x: 0, y: 1, width: 10, height: 4 });
    const [left, right] = horizontal({ x: 0, y: 0, width: 10, height: 1 }, [min(1), length(4)]);
    expect(left).toEqual({ x: 0, y: 0, width: 6, height: 1 });
    expect(right).toEqual({ x: 6, y: 0, width: 4, height: 1 });
  });
});

describe("the buffer", () => {
  it("draws a bordered block and returns the area inside it", () => {
    const buffer = new Buffer(10, 4);
    const inner = buffer.block(buffer.area, { title: line([span("hi")]) });
    expect(inner).toEqual({ x: 1, y: 1, width: 8, height: 2 });
    buffer.paragraph(inner, [line([span("body")])]);
    expect(buffer.toString().split("\n")).toEqual([
      "╭hi──────╮",
      "│body    │",
      "│        │",
      "╰────────╯",
    ]);
  });

  it("clips a line to the pane instead of wrapping it", () => {
    const buffer = new Buffer(5, 1);
    buffer.paragraph(buffer.area, [line([span("far too long")])]);
    expect(buffer.toString()).toBe("far t");
  });

  it("emits an escape only where the style changes", () => {
    const buffer = new Buffer(4, 1);
    buffer.setSpans(0, 0, [span("ab", { fg: "red" }), span("cd", { fg: "red" })]);
    const ansi = buffer.toAnsi();
    const colourChanges = ansi.match(/\[[0-9;]*m/g) ?? [];
    expect(colourChanges, "one style, so one escape plus the closing reset").toHaveLength(2);
    expect(ansi).toContain(`${sgr({ fg: "red" })}abcd`);
    // Each row is positioned rather than newline-separated.
    expect(ansi.startsWith(`${ESC}[1;1H`)).toBe(true);
    expect(ansi).not.toContain("\n");
  });

  it("survives being drawn at zero size", () => {
    const buffer = new Buffer(0, 0);
    expect(() => buffer.block(buffer.area, { title: line("x") })).not.toThrow();
    expect(() => buffer.paragraph(buffer.area, [blankLine()])).not.toThrow();
    expect(buffer.toString()).toBe("");
  });
});
