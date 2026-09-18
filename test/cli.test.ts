/**
 * The published entry point: the binary has to run when npm installs it as a symlink in
 * `node_modules/.bin`, not just when node is pointed at the file.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const built = existsSync(CLI);

function run(entry: string, ...args: string[]): string {
  return execFileSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

describe.runIf(built)("the built CLI", () => {
  it("reports its version", () => {
    expect(run(CLI, "--version").trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints help without a terminal", () => {
    expect(run(CLI, "--help")).toContain("a REPL for TypeSafe AI System One questions");
  });

  it("runs through a bin symlink, the way npm installs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-bin-"));
    try {
      const link = join(dir, "jev");
      symlinkSync(CLI, link);
      expect(run(link, "--version").trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start the REPL when stdout is not a terminal", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync(process.execPath, [CLI], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      const error = e as { status?: number; stderr?: string };
      status = error.status ?? 0;
      stderr = error.stderr ?? "";
    }
    expect(status).toBe(1);
    expect(stderr).toContain("interactive terminal");
  });
});
