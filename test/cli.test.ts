/**
 * The published entry point: the binary has to run when npm installs it as a symlink in
 * `node_modules/.bin`, not just when node is pointed at the file.
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const built = existsSync(CLI);

function run(entry: string, ...args: string[]): string {
  return execFileSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

/** What the CLI did: exit status included, because the one-shot commands are meant for scripts. */
interface Attempt {
  status: number;
  stdout: string;
  stderr: string;
}

function jev(
  args: readonly string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Attempt {
  const done = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input: options.input ?? "",
    env: { ...process.env, TYPESAFE_API_KEY: "", JEV_PRICE: "", ...options.env },
  });
  if (done.error) throw done.error;
  return { status: done.status ?? 1, stdout: done.stdout, stderr: done.stderr };
}

/**
 * The same, but without blocking this process: the live tests answer from a server running here,
 * and a synchronous spawn would hold the event loop shut so the request could never be served.
 */
function jevAsync(
  args: readonly string[],
  options: { input?: string; env?: Record<string, string> } = {},
): Promise<Attempt> {
  return new Promise((done, fail) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, TYPESAFE_API_KEY: "", JEV_PRICE: "", ...options.env },
      },
      (error, stdout, stderr) => {
        const code = error as (Error & { code?: number }) | null;
        if (code && typeof code.code !== "number") fail(code);
        else done({ status: code?.code ?? 0, stdout, stderr });
      },
    );
    child.stdin?.end(options.input ?? "");
  });
}

const PAGE = `The payout failed again, third time this month.
---
is_urgent? The message conveys urgency
  yes: A deadline or money being lost now
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
`;

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

describe("the manifest", () => {
  it("keeps the version the client reports in step with package.json", async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { version: string };
    const { VERSION } = await import("../src/typesafe/constants.js");
    expect(VERSION, "bump src/typesafe/constants.ts when bumping package.json").toBe(
      manifest.version,
    );
  });
});

describe.runIf(built)("the one-shot commands", () => {
  it("checks a page and says what it parsed into", () => {
    const { status, stdout } = jev(["check"], { input: PAGE });
    expect(status).toBe(0);
    expect(stdout).toContain("2 questions");
    expect(stdout).toContain("is_urgent (noul)");
  });

  it("fails the check on a broken page, with the line number", () => {
    const { status, stderr } = jev(["check"], { input: "a state\n---\nbroken?\n" });
    expect(status).toBe(1);
    expect(stderr).toMatch(/line 3/);
  });

  it("prints the request body, and takes it back in", () => {
    const body = jev(["json"], { input: PAGE });
    expect(body.status).toBe(0);
    expect(JSON.parse(body.stdout)).toMatchObject({ model: "jev-latest" });
    const again = jev(["json"], { input: body.stdout });
    expect(again.stdout).toBe(body.stdout);
  });

  it("reads a file as well as stdin", () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-page-"));
    try {
      const path = join(dir, "triage.jev");
      writeFileSync(path, PAGE);
      expect(jev(["json", path]).stdout).toBe(jev(["json"], { input: PAGE }).stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers offline, without a key and without a terminal", () => {
    const { status, stdout, stderr } = jev(["run"], { input: PAGE });
    expect(status).toBe(0);
    expect(stdout).toContain("is_urgent");
    expect(stdout).toContain("department");
    expect(stderr).toContain("Simulated answers");
  });

  it("prints a raw body for --json, so a script can pipe it to jq", () => {
    const { status, stdout } = jev(["run", "--json"], { input: PAGE });
    expect(status).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ answers: { is_urgent: { type: "noul" } } });
  });

  it("takes the state off the command line", () => {
    const { stdout } = jev(["json", "--state", "All fine, thanks!"], { input: PAGE });
    expect(JSON.parse(stdout)).toMatchObject({ state: "All fine, thanks!" });
  });

  it("prices the cost table", () => {
    const { status, stdout } = jev(["cost", "--price", "0.20/1.00"], { input: PAGE });
    expect(status).toBe(0);
    expect(stdout).toContain("per call");
    expect(stdout).toContain("$0.20/$1.00 per Mtok");
  });

  it("takes the rates from the environment too", () => {
    const { stdout } = jev(["cost"], { input: PAGE, env: { JEV_PRICE: "0.20/1.00" } });
    expect(stdout).toContain("per call");
  });

  it("generates the session as code", () => {
    expect(jev(["ts"], { input: PAGE }).stdout).toContain("client.systemOne");
    expect(jev(["rust"], { input: PAGE }).stdout).toContain("typesafe");
  });

  it("refuses to send a request with no state", () => {
    const { status, stderr } = jev(["run"], { input: "---\nis_urgent? conveys urgency\n" });
    expect(status).toBe(1);
    expect(stderr).toMatch(/No state/);
  });

  it("exits 2 on a command line it cannot parse", () => {
    expect(jev(["run", "--nope"], { input: PAGE }).status).toBe(2);
    expect(jev(["run", "--threshold", "5"], { input: PAGE }).status).toBe(2);
    expect(jev(["run", "--state"], { input: PAGE }).status).toBe(2);
    expect(jev(["frobnicate"]).status).toBe(2);
  });

  it("exits 1 when the file is not there", () => {
    const { status, stderr } = jev(["json", "/no/such/page.jev"]);
    expect(status).toBe(1);
    expect(stderr).toContain("could not read");
  });

  it("lists the commands in --help", () => {
    const help = jev(["--help"]).stdout;
    for (const command of ["run", "json", "cost", "ts", "rust", "check"]) {
      expect(help).toContain(command);
    }
    expect(help).toContain("--state");
  });

  it("points at the one-shot commands when the REPL has no terminal", () => {
    const { status, stderr } = jev([]);
    expect(status).toBe(1);
    expect(stderr).toContain("jev run");
  });
});

describe.runIf(built)("a live call", () => {
  let server: Server;
  let baseUrl: string;
  let status = 200;
  let body = "";

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  const live = (args: readonly string[]): Promise<Attempt> =>
    jevAsync(args, {
      input: PAGE,
      env: { TYPESAFE_API_KEY: "sk-test", TYPESAFE_BASE_URL: baseUrl },
    });

  it("prints the answers the API sent, and the usage it counted", async () => {
    status = 200;
    body = JSON.stringify({
      model: "jev-1",
      answers: { is_urgent: { type: "noul", noul: 0.91 } },
      usage: { input_tokens: 120, output_tokens: 30 },
    });
    const { status: code, stdout } = await live(["run", "--price", "0.20/1.00"]);
    expect(code).toBe(0);
    expect(stdout).toContain("0.91");
    expect(stdout).toContain("120 in / 30 out");
    expect(stdout).toContain("$");
    // The question the server skipped is named, not silently dropped.
    expect(stdout).toContain("department: no answer came back");
  });

  it("hands --json the body the API actually sent", async () => {
    status = 200;
    body = JSON.stringify({ model: "jev-1", answers: {}, usage: {} });
    const { status: code, stdout } = await live(["run", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ model: "jev-1" });
  });

  it("exits 1 and explains itself when the API says no", async () => {
    status = 401;
    body = JSON.stringify({ error: { message: "bad key" } });
    const { status: code, stderr } = await live(["run"]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/bad key|authentication/i);
  });

  it("--mock stays offline even with a key set", async () => {
    status = 500;
    body = "boom";
    const { status: code, stderr } = await live(["run", "--mock"]);
    expect(code).toBe(0);
    expect(stderr).toContain("Simulated answers");
  });
});
