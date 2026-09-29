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
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as mock from "../src/repl/mock.js";
import { Client } from "../src/typesafe/client.js";
import { noul } from "../src/typesafe/questions.js";
import { isYes } from "../src/typesafe/responses.js";

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

  it("appends turns to the state, in the order they were given", () => {
    const { stdout } = jev(
      ["json", "--turn", "agent: We are looking into it.", "--turn", "customer: Refund me."],
      { input: PAGE },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      state: [
        { said: expect.any(String) as unknown as string },
        { who: "agent", said: "We are looking into it." },
        { who: "customer", said: "Refund me." },
      ],
    });
  });

  it("refuses a turn on a state that is not a conversation", () => {
    const body =
      '{"state": {"ticket": 1}, "questions": {"a": {"type": "noul", "instructions": "x"}}}';
    const { status, stderr } = jev(["json", "--turn", "agent: hello"], { input: body });
    expect(status).toBe(2);
    expect(stderr).toContain("not a conversation");
  });

  it("counts the thread in the cost table", () => {
    const { stdout } = jev(
      ["cost", "--turn", "agent: We are looking into it.", "--price", "0.20/1.00"],
      {
        input: PAGE,
      },
    );
    expect(stdout).toContain("2 turns");
    expect(stdout).toContain("asked after every turn: 2 calls");
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
    expect(jev(["ts"], { input: PAGE }).stdout).toContain("client.ask(");
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
    expect(help).toContain("--turn");
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

const EVAL_PAGE = `placeholder
---
is_urgent? The message conveys urgency
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
  sales = Pricing and plans
frustration: How frustrated the customer appears
  Calm < Frustrated but civil < Very angry
`;

const EVAL_CASES = [
  '{"id": "t-001", "state": "Stripe has been failing for 3 days", "expect": {"is_urgent": true, "department": "technical", "frustration": 2}}',
  '{"state": "Can I get a copy of last month\'s invoice?", "expect": {"department": "billing", "is_urgent": false}}',
  '{"state": "What does the enterprise plan include?", "expect": {"department": "sales", "frustration": 0}}',
].join("\n");

/** A directory with a page and a cases file in it, for the duration of one test. */
function withFiles(cases: string, run: (page: string, casesPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "jev-eval-"));
  try {
    const page = join(dir, "triage.jev");
    const casesPath = join(dir, "cases.jsonl");
    writeFileSync(page, EVAL_PAGE);
    writeFileSync(casesPath, cases);
    run(page, casesPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(built)("scoring a rubric offline", () => {
  it("reports every question it was given labels for", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      const { status, stdout, stderr } = jev(["eval", page, "--cases", cases, "--mock"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/is_urgent\s+noul/);
      expect(stdout).toMatch(/department\s+choice/);
      expect(stdout).toMatch(/frustration\s+score/);
      expect(stdout).toContain("best f1 at");
      expect(stdout).toContain("3 cases · 3 answered · 0 errors");
      expect(stderr).toContain("Simulated answers");
    });
  });

  it("prints the whole report as JSON for a script to read", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      const { status, stdout } = jev(["eval", page, "--cases", cases, "--mock", "--json"]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as { cases: number; questions: Record<string, unknown> };
      expect(report.cases).toBe(3);
      expect(Object.keys(report.questions)).toEqual(["is_urgent", "department", "frustration"]);
    });
  });

  it("refuses a cases file with a bad line, and says which line", () => {
    withFiles(`${EVAL_CASES}\n{"state": "no expectations"}`, (page, cases) => {
      const { status, stderr } = jev(["eval", page, "--cases", cases, "--mock"]);
      expect(status).toBe(1);
      expect(stderr).toContain("cases line 4:");
    });
  });

  it("exits 2 on a command line eval cannot use", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      const state = jev(["eval", page, "--cases", cases, "--mock", "--state", "hello"]);
      expect(state.status).toBe(2);
      expect(state.stderr).toContain("--state does not apply to eval: the cases carry the states.");

      const turn = jev(["eval", page, "--cases", cases, "--mock", "--turn", "a: b"]);
      expect(turn.status).toBe(2);
      expect(turn.stderr).toContain("--turn does not apply to eval");

      const rateless = jev(["eval", page, "--cases", cases, "--mock", "--max-cost", "1"]);
      expect(rateless.status).toBe(2);
      expect(rateless.stderr).toContain(
        "--max-cost needs rates: pass --price <in>/<out> or set JEV_PRICE.",
      );

      expect(jev(["eval", page, "--cases", cases, "--concurrency", "0"]).status).toBe(2);
      expect(jev(["eval", "--cases", "-", "--mock"], { input: EVAL_PAGE }).stderr).toContain(
        "the page and the cases cannot both come from stdin.",
      );
      expect(jev(["eval", page, "--mock"]).status).toBe(2);
    });
  });

  it("exits 1 and names the question when a bar is not met", () => {
    // The simulator is deterministic, so a case can be labelled with what it is bound to get wrong.
    const state = "A payout failed again.";
    const answer = mock.answer(state, "is_urgent", {
      type: "noul",
      instructions: "The message conveys urgency",
    });
    const yes = answer?.type === "noul" && isYes(answer, 0.5);
    const cases = `{"state": ${JSON.stringify(state)}, "expect": {"is_urgent": ${!yes}}}`;
    withFiles(cases, (page, casesPath) => {
      const { status, stderr } = jev([
        "eval",
        page,
        "--cases",
        casesPath,
        "--mock",
        "--min-accuracy",
        "1",
      ]);
      expect(status).toBe(1);
      expect(stderr).toContain("jev eval: is_urgent accuracy 0.00 is below 1.00.");
    });
  });

  it("scores a conversation labelled per turn, and says when the noul noticed", () => {
    const thread = JSON.stringify([
      { who: "customer", said: "Hi there" },
      { who: "agent", said: "How can I help?" },
      { who: "customer", said: "Checkout has been down for an hour, we are losing orders" },
    ]);
    const cases = `{"id": "th-1", "state": ${thread}, "expect": {"is_urgent": {"by_turn": 3}, "department": "technical"}}`;
    withFiles(cases, (page, casesPath) => {
      const { status, stdout } = jev(["eval", page, "--cases", casesPath, "--mock"]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/is_urgent\s+noul\s+3 cases/);
      expect(stdout).toMatch(/department\s+choice\s+1 case /);
      expect(stdout).toMatch(/by turn {2}1 thread · /);
      expect(stdout).toContain("3 cases · 3 answered · 0 errors");
      const json = jev(["eval", page, "--cases", casesPath, "--mock", "--json"]);
      const report = JSON.parse(json.stdout) as {
        questions: {
          is_urgent: { latency: { threads: number; cases: Array<{ expected: number }> } };
        };
      };
      expect(report.questions.is_urgent.latency.threads).toBe(1);
      expect(report.questions.is_urgent.latency.cases[0]?.expected).toBe(3);
    });
    withFiles('{"state": "plain text", "expect": {"is_urgent": {"by_turn": 2}}}', (page, c) => {
      const { status, stderr } = jev(["eval", page, "--cases", c, "--mock"]);
      expect(status).toBe(1);
      expect(stderr).toContain(
        "cases line 1: is_urgent gives by_turn, but the state is not a conversation of turns.",
      );
    });
  });

  it("lists eval and its flags in --help", () => {
    const help = jev(["--help"]).stdout;
    expect(help).toContain("eval");
    for (const flag of [
      "--cases",
      "--concurrency",
      "--cache",
      "--max-cost",
      "--min-accuracy",
      "--compare",
      "--fail-on-regression",
      "--calibrate",
      "--target-accuracy",
    ]) {
      expect(help).toContain(flag);
    }
  });
});

/** The candidate page: is_urgent asked another way, frustration dropped, sarcasm added. */
const EVAL_PAGE_B = `placeholder
---
is_urgent? The message conveys urgency or time pressure
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
  sales = Pricing and plans
sarcasm? The customer is being sarcastic
`;

/** A directory holding two pages and a cases file, for the duration of one test. */
function withPages(
  cases: string,
  run: (a: string, b: string, casesPath: string) => void,
  pageB: string = EVAL_PAGE_B,
): void {
  const dir = mkdtempSync(join(tmpdir(), "jev-compare-"));
  try {
    const a = join(dir, "a.jev");
    const b = join(dir, "b.jev");
    const casesPath = join(dir, "cases.jsonl");
    writeFileSync(a, EVAL_PAGE);
    writeFileSync(b, pageB);
    writeFileSync(casesPath, cases);
    run(a, b, casesPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.runIf(built)("comparing two pages offline", () => {
  it("reports the difference per shared question, and what only one page asks", () => {
    withPages(EVAL_CASES, (a, b, cases) => {
      const { status, stdout, stderr } = jev([
        "eval",
        a,
        "--compare",
        b,
        "--cases",
        cases,
        "--mock",
      ]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/is_urgent\s+noul\s+2 paired cases/);
      expect(stdout).toMatch(/department\s+choice\s+3 paired cases/);
      expect(stdout).toContain("McNemar");
      expect(stdout).toContain("only in a: frustration");
      expect(stdout).toContain("only in b: sarcasm");
      expect(stdout).toContain("3 cases · a 3 answered, 0 errors · b 3 answered, 0 errors");
      expect(stderr).toContain("Simulated answers");
    });
  });

  it("prints both reports and the comparison as JSON", () => {
    withPages(EVAL_CASES, (a, b, cases) => {
      const { status, stdout } = jev([
        "eval",
        a,
        "--compare",
        b,
        "--cases",
        cases,
        "--mock",
        "--json",
      ]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
      expect(report["a"]?.["page"]).toBe(a);
      expect(report["b"]?.["page"]).toBe(b);
      expect(Object.keys(report["questions"] ?? {})).toEqual(["is_urgent", "department"]);
      expect(report["onlyB"]).toEqual(["sarcasm"]);
      expect(report["regressions"]).toEqual([]);
    });
  });

  it("names the page a label does not fit", () => {
    withPages('{"state": "x", "expect": {"frustration": 2, "sarcasm": 1}}', (a, b, cases) => {
      const { status, stderr } = jev(["eval", a, "--compare", b, "--cases", cases, "--mock"]);
      expect(status).toBe(1);
      expect(stderr).toContain(`cases line 1: ${b}: sarcasm is a noul`);
    });
  });

  it("exits 2 when the pages cannot be told apart on the command line", () => {
    withPages(EVAL_CASES, (a, b, cases) => {
      const both = jev(["eval", "--compare", "-", "--cases", cases, "--mock"], { input: "x" });
      expect(both.status).toBe(2);
      expect(both.stderr).toContain(
        "only one of the page, --compare and --cases can come from stdin.",
      );
      const lonely = jev(["eval", a, "--cases", cases, "--mock", "--fail-on-regression"]);
      expect(lonely.status).toBe(2);
      expect(lonely.stderr).toContain(
        "--fail-on-regression needs --compare: there is nothing to regress from.",
      );
      expect(jev(["eval", a, "--compare", b, "--mock"]).status).toBe(2);
    });
  });

  it("fails on a regression the test can see, and only when asked to", () => {
    // Label every state the way page a answers it, so page a is always right and every case
    // page b answers differently is one it broke. The simulator is deterministic, so this holds.
    const noulOf = (instructions: string, state: string): boolean => {
      const answer = mock.answer(state, "is_urgent", { type: "noul", instructions });
      return answer?.type === "noul" && isYes(answer, 0.5);
    };
    const lines: string[] = [];
    let broke = 0;
    for (let i = 0; broke < 8; i++) {
      const state = `ticket ${i}`;
      const a = noulOf("The message conveys urgency", state);
      if (a !== noulOf("The message conveys urgency or time pressure", state)) broke += 1;
      lines.push(JSON.stringify({ state, expect: { is_urgent: a } }));
    }
    withPages(lines.join("\n"), (a, b, cases) => {
      const args = ["eval", a, "--compare", b, "--cases", cases, "--mock"];
      const quiet = jev(args);
      expect(quiet.status).toBe(0);
      expect(quiet.stdout).toContain("0 fixed · 8 broke · 0 changed");
      expect(quiet.stdout).toContain("b is significantly worse");
      const strict = jev([...args, "--fail-on-regression"]);
      expect(strict.status).toBe(1);
      expect(strict.stderr).toContain(
        `jev eval: is_urgent is significantly worse in ${b} (McNemar p 0.008).`,
      );
    });
  });

  it("holds both pages to --min-accuracy, and says which one missed", () => {
    // States both pages answer alike, labelled the other way: both pages score 0.
    const lines: string[] = [];
    for (let i = 0; lines.length < 3; i++) {
      const state = `ticket ${i}`;
      const [a, b] = [
        "The message conveys urgency",
        "The message conveys urgency or time pressure",
      ].map((instructions) => {
        const answer = mock.answer(state, "is_urgent", { type: "noul", instructions });
        return answer?.type === "noul" && isYes(answer, 0.5);
      });
      if (a === b) lines.push(JSON.stringify({ state, expect: { is_urgent: !a } }));
    }
    withPages(lines.join("\n"), (a, b, cases) => {
      const args = ["eval", a, "--compare", b, "--cases", cases, "--mock", "--min-accuracy", "0.5"];
      const { status, stderr } = jev(args);
      expect(status).toBe(1);
      expect(stderr).toContain(`jev eval: ${a}: is_urgent accuracy 0.00 is below 0.50.`);
      expect(stderr).toContain(`jev eval: ${b}: is_urgent accuracy 0.00 is below 0.50.`);
    });
  });
});

describe.runIf(built)("writing the calibration back", () => {
  it("writes the bars the run supports into the page, and says what changed", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      const before = readFileSync(page, "utf8");
      const first = jev(["eval", page, "--cases", cases, "--mock", "--calibrate"]);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain("calibration  target accuracy 0.90");
      // The simulator is deterministic, so what these three cases support is fixed.
      expect(first.stdout).toContain(
        "is_urgent    left alone         no threshold gives an F1 above 0",
      );
      expect(first.stdout).toMatch(/frustration\s+@confidence 0\.25\s+was none\s+accuracy 1\.00/);
      expect(first.stdout).toContain(`wrote 1 bar to ${page}`);
      const after = readFileSync(page, "utf8");
      expect(after).toContain("  Calm < Frustrated but civil < Very angry\n  @confidence 0.25\n");
      // Only bar lines were added: take them out and the page is what it was.
      expect(after.replace(/\n\s*@(threshold|confidence) [\d.]+/g, "")).toBe(before);

      const again = jev(["eval", page, "--cases", cases, "--mock", "--calibrate"]);
      expect(again.stdout).toContain("nothing to write:");
      expect(readFileSync(page, "utf8")).toBe(after);
      expect(jev(["check", page]).stdout).toContain("frustration (score, @confidence 0.25)");
    });
  });

  it("adds the calibration to the JSON report", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      const args = ["eval", page, "--cases", cases, "--mock", "--calibrate", "--json"];
      const { status, stdout } = jev([...args, "--target-accuracy", "0.5"]);
      expect(status).toBe(0);
      const report = JSON.parse(stdout) as { calibration: Record<string, unknown> };
      expect(report.calibration).toMatchObject({ page, target: 0.5 });
      expect(Object.keys(report.calibration["questions"] as object)).toEqual([
        "is_urgent",
        "department",
        "frustration",
      ]);
    });
  });

  it("reads the page's own threshold everywhere a threshold is read", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      writeFileSync(page, EVAL_PAGE.replace("urgency\n", "urgency\n  @threshold 0.35\n"));
      const run = jev(["run", page, "--state", "A payout failed", "--mock"]);
      expect(run.stdout).toContain("at threshold 0.35");
      const scored = jev(["eval", page, "--cases", cases, "--mock"]);
      expect(scored.stdout).toMatch(/0\.35 \*/);
      expect(jev(["ts", page]).stdout).toContain("is_urgent.noul >= 0.35");
    });
  });

  it("refuses what it cannot write back", () => {
    withFiles(EVAL_CASES, (page, cases) => {
      const expectUsage = (args: string[], message: string, input?: string): void => {
        const attempt = jev(args, input === undefined ? {} : { input });
        expect(attempt.status).toBe(2);
        expect(attempt.stderr).toContain(message);
      };
      expectUsage(
        ["eval", page, "--compare", page, "--cases", cases, "--calibrate"],
        "--calibrate and --compare do not mix: calibrate one page at a time.",
      );
      expectUsage(
        ["eval", "--cases", cases, "--calibrate"],
        "--calibrate writes the page back, so the page has to be a file, not stdin.",
        EVAL_PAGE,
      );
      expectUsage(
        ["eval", page, "--cases", cases, "--target-accuracy", "0.8"],
        "--target-accuracy only applies with --calibrate.",
      );
      expectUsage(
        ["eval", page, "--cases", cases, "--calibrate", "--target-accuracy", "2"],
        "--target-accuracy takes a number from 0 to 1.",
      );
      const body = jev(["json", page]).stdout;
      writeFileSync(page, body);
      const refused = jev(["eval", page, "--cases", cases, "--mock", "--calibrate"]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain(
        "jev eval: --calibrate needs a .jev page: a request body has nowhere to keep a bar.",
      );
      expect(readFileSync(page, "utf8")).toBe(body);
    });
  });
});

describe.runIf(built)("a live eval", () => {
  let server: Server;
  let baseUrl: string;
  let requests = 0;
  const PAGE_ONE = "placeholder\n---\nis_urgent? The message conveys urgency\n";
  const CASES = [
    '{"id": "u-1", "state": "urgent: the payout failed", "expect": {"is_urgent": true}}',
    '{"id": "u-2", "state": "urgent: checkout is down", "expect": {"is_urgent": true}}',
    '{"id": "c-1", "state": "a question about the plan", "expect": {"is_urgent": false}}',
    '{"id": "c-2", "state": "a note of thanks", "expect": {"is_urgent": false}}',
  ].join("\n");

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      req.on("end", () => {
        requests += 1;
        const state = String((JSON.parse(body) as { state: unknown }).state);
        if (state.includes("refuse")) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "this state is not allowed" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            model: "jev-1",
            answers: { is_urgent: { type: "noul", noul: state.includes("urgent") ? 0.9 : 0.1 } },
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  /** A run against the fake API, with the page on stdin and the cases in a file. */
  function live(cases: string, args: readonly string[]): Promise<Attempt> {
    const dir = mkdtempSync(join(tmpdir(), "jev-live-eval-"));
    const path = join(dir, "cases.jsonl");
    writeFileSync(path, cases);
    requests = 0;
    return jevAsync(["eval", "--cases", path, ...args], {
      input: PAGE_ONE,
      env: { TYPESAFE_API_KEY: "sk-test", TYPESAFE_BASE_URL: baseUrl },
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("asks once per case and counts what the API counted", async () => {
    const { status, stdout, stderr } = await live(CASES, []);
    expect(status).toBe(0);
    expect(requests).toBe(4);
    expect(stdout).toMatch(/0\.50 \*\s+1\.00\s+1\.00/);
    expect(stdout).toContain("40 in / 20 out tokens");
    expect(stderr).toContain("jev eval: 4 cases, ≈");
  });

  it("answers a second run from the cache, without sending anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-cache-"));
    try {
      const first = await live(CASES, ["--cache", dir]);
      expect(first.status).toBe(0);
      expect(requests).toBe(4);
      const again = await live(CASES, ["--cache", dir]);
      expect(requests).toBe(0);
      expect(again.stdout).toBe(first.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a cache a replaying client can read, and reads what a recording client kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-cache-"));
    const questions = { is_urgent: noul("The message conveys urgency") };
    try {
      const first = await live(CASES, ["--cache", dir]);
      expect(first.status).toBe(0);
      const replaying = new Client({ replay: dir, model: "jev-latest" });
      const res = await replaying.systemOne("urgent: the payout failed", questions);
      expect(res.noul("is_urgent")?.noul).toBe(0.9);

      rmSync(dir, { recursive: true, force: true });
      const recording = new Client({
        apiKey: "sk-test",
        baseUrl,
        model: "jev-latest",
        record: dir,
      });
      for (const state of [
        "urgent: the payout failed",
        "urgent: checkout is down",
        "a question about the plan",
        "a note of thanks",
      ]) {
        await recording.systemOne(state, questions);
      }
      const again = await live(CASES, ["--cache", dir]);
      expect(requests).toBe(0);
      expect(again.stdout).toBe(first.stdout);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to send when the estimate is above --max-cost", async () => {
    const { status, stderr } = await live(CASES, [
      "--max-cost",
      "0.000001",
      "--price",
      "0.20/1.00",
    ]);
    expect(status).toBe(1);
    expect(requests).toBe(0);
    expect(stderr).toContain("refusing to send");
  });

  it("compares two pages over one pool, one preflight and one cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-live-compare-"));
    try {
      const other = join(dir, "b.jev");
      writeFileSync(other, "placeholder\n---\nis_urgent? Something needs doing now\n");
      const cache = join(dir, "cache");
      const args = ["--compare", other, "--cache", cache, "--price", "0.20/1.00"];
      const first = await live(CASES, args);
      expect(first.status).toBe(0);
      expect(requests).toBe(8);
      expect(first.stderr).toContain("jev eval: 4 + 4 cases over two pages, ≈");
      expect(first.stderr).toContain("at $0.20/$1.00 per Mtok");
      expect(first.stdout).toContain("80 in / 40 out tokens");
      expect(first.stdout).toContain("McNemar: no discordant pairs, nothing to test");
      const again = await live(CASES, args);
      expect(requests).toBe(0);
      expect(again.stdout).toBe(first.stdout);
      const refused = await live(CASES, [
        ...args.slice(0, 2),
        "--max-cost",
        "0.000001",
        "--price",
        "0.20/1.00",
      ]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("refusing to send");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not calibrate over a run with errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-live-calibrate-"));
    try {
      const page = join(dir, "page.jev");
      const cases = join(dir, "cases.jsonl");
      writeFileSync(page, PAGE_ONE);
      writeFileSync(
        cases,
        `${CASES}\n{"id": "bad", "state": "refuse this one", "expect": {"is_urgent": true}}`,
      );
      const { status, stderr } = await jevAsync(["eval", page, "--cases", cases, "--calibrate"], {
        env: { TYPESAFE_API_KEY: "sk-test", TYPESAFE_BASE_URL: baseUrl },
      });
      expect(status).toBe(1);
      expect(stderr).toContain(
        "jev eval: not calibrating: 1 case came back with errors, so the numbers are incomplete.",
      );
      expect(readFileSync(page, "utf8")).toBe(PAGE_ONE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries on when one case is refused, and says which", async () => {
    const cases = `${CASES}\n{"id": "bad", "state": "refuse this one", "expect": {"is_urgent": true}}`;
    const { status, stdout } = await live(cases, []);
    expect(status).toBe(1);
    expect(stdout).toContain("case 5 (bad):");
    expect(stdout).toContain("5 cases · 4 answered · 1 error");
  });
});
