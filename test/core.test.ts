/**
 * The `jev-repl/core` export is the web REPL's whole dependency, so it has to stay loadable in a
 * browser: nothing under it may reach for `node:` builtins, `process` or the terminal.
 */

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { codegen, mock, Session, sketch } from "../src/core.js";

const SRC = resolve(import.meta.dirname, "../src");
const ENTRY = resolve(SRC, "core.ts");

/** Every source file reachable from `src/core.ts`, following relative imports. */
function graph(): string[] {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      const spec = match[1] as string;
      if (!spec.startsWith(".")) continue;
      queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return [...seen].sort();
}

describe("the browser-safe core", () => {
  const files = graph();

  it("reaches the notation, the client and the generators", () => {
    const names = files.map((f) => relative(SRC, f));
    expect(names).toContain("repl/sketch.ts");
    expect(names).toContain("repl/codegen.ts");
    expect(names).toContain("typesafe/client.ts");
  });

  it("pulls in nothing that needs a terminal", () => {
    const names = files.map((f) => relative(SRC, f));
    expect(names).not.toContain("repl/app.ts");
    expect(names).not.toContain("repl/ui.ts");
    expect(names).not.toContain("tui/terminal.ts");
    expect(names).not.toContain("cli.ts");
  });

  it("imports no node builtin", () => {
    const offenders = files.filter((f) => /from\s+"node:/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("touches `process` only behind a typeof guard", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!/\bprocess\b/.test(line)) continue;
        if (/typeof process/.test(line)) continue;
        if (/process\.(env|version|versions|platform|arch)/.test(line)) offenders.push(line.trim());
      }
    }
    // The two guarded reads in the client are inside `typeof process === "undefined"` branches.
    expect(offenders).toEqual([
      "return `node ${process.version} (${process.platform}; ${process.arch})`;",
    ]);
  });

  it("parses, answers and generates without a terminal", () => {
    const page = sketch.parse(
      ["A payout failed for the third time.", "---", "is_urgent? The message conveys urgency"].join(
        "\n",
      ),
    );
    expect(page.ok()).toBe(true);
    const session: Session = page.toSession();
    expect(session.questions.map(([name]) => name)).toEqual(["is_urgent"]);

    const answer = mock.answer(session.state, "is_urgent", session.questionsJson()["is_urgent"]!);
    expect(answer?.type).toBe("noul");

    expect(codegen.typescript(session, "jev-latest", 0.5)).toContain("noul(");
    expect(sketch.render(session)).toContain("is_urgent?");
  });
});
