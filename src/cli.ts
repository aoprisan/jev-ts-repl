#!/usr/bin/env node
/**
 * `jev` — an interactive playground for learning TypeSafe AI System One questions.
 *
 * Run it with a `TYPESAFE_API_KEY` for live answers, or without one to explore offline with
 * simulated answers. `:help` inside lists every command; `:lesson` starts the guided track.
 *
 * With a subcommand it does not open a terminal at all: `jev run page.jev`, `jev json`, `jev cost`
 * and friends read a page (or stdin) and print one answer, so a session shaped in the REPL can be
 * saved with `:save` and then run from a script, a Makefile or CI.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as install from "./agent/installer.js";
import type { Host, Sent } from "./agent/mcp.js";
import { serve } from "./agent/serve.js";
import type { JsonObject } from "./json.js";
import { compact, pretty } from "./json.js";
import { App } from "./repl/app.js";
import type { Msg } from "./repl/app.js";
import * as cost from "./repl/cost.js";
import * as evaluate from "./repl/evaluate.js";
import type { Command } from "./repl/headless.js";
import * as headless from "./repl/headless.js";
import { errorLines } from "./repl/format.js";
import type { Session } from "./repl/session.js";
import { parseTurn } from "./repl/session.js";
import * as sketch from "./repl/sketch.js";
import { render } from "./repl/ui.js";
import { Terminal } from "./tui/terminal.js";
import { blankLine, linesText } from "./tui/style.js";
import { Client } from "./typesafe/client.js";
import { API_KEY_ENV, VERSION } from "./typesafe/constants.js";
import { decodeSystemOne, makeSystemOneResponse } from "./typesafe/responses.js";

const HELP = `jev — a REPL for TypeSafe AI System One questions

Set TYPESAFE_API_KEY for live answers; without one, answers are simulated locally.

  jev                    the REPL: :help for commands, :lesson for the guided track,
                         :sketch to write a request as one page, :quit to leave
  jev <command> [file]   one shot, no terminal needed
  jev mcp                serve the same commands to an agent over MCP, on stdin/stdout
  jev install            register the MCP server and the jev skill with an agent
                         (Claude Code, Codex, OpenCode, pi) — jev install --help

Commands
${headless.COMMANDS.map(([name, about]) => `  ${name.padEnd(22)} ${about}`).join("\n")}

The file is a .jev sketch page or a request body; \`-\`, or no file at all, reads stdin.

Options
  --state <text>         set the state, or replace the one on the page
  --turn <who>: <text>   append a turn, making the state a conversation; repeatable
  --model <name>         the model to ask
  --threshold <0-1>      what counts as a yes for a noul (default 0.5)
  --price <in>/<out>     dollars per million tokens, input then output
  --timeout <seconds>    per-attempt timeout for a live call
  --mock                 simulated answers, even when a key is set
  --json                 print the raw response body instead of the answer page
  --help, -h             this message
  --version, -v          the version of this package

Options for eval
  --cases <file>         the JSON Lines file of labelled states to score, or \`-\`
  --concurrency <n>      how many cases are in the air at once (default 4)
  --cache <dir>          keep the responses here, so running it again sends nothing
  --max-cost <dollars>   refuse to send when the estimate is above this
  --min-accuracy <0-1>   exit 1 when a scored question falls below this
  --compare <page>       run a second page over the same cases and report the difference
  --fail-on-regression   with --compare, exit 1 when the second page is significantly worse
  --calibrate            write the thresholds and confidence bars the run supports into the page
  --target-accuracy <0-1>  the accuracy a confidence bar has to reach (default 0.9)

Exit status is 0 when it worked, 1 when the call or the file did not, 2 when the
command line did not parse.
`;

/** Everything the one-shot commands read off the command line. */
interface Options {
  file: string;
  state?: string;
  /** Turns appended to the state, in the order they were given. */
  turns: string[];
  model?: string;
  threshold: number;
  rates?: cost.Rates;
  timeoutMs?: number;
  mock: boolean;
  json: boolean;
  /** `jev eval`: the file of labelled cases, and what to do with them. */
  cases?: string;
  concurrency: number;
  cache?: string;
  maxCost?: number;
  minAccuracy?: number;
  /** `jev eval --compare`: the second page, and whether a regression fails the run. */
  compare?: string;
  failOnRegression: boolean;
  /** `jev eval --calibrate`: write the bars back into the page, aiming at this accuracy. */
  calibrate: boolean;
  targetAccuracy?: number;
}

/** A usage error: the command line itself did not make sense. */
class UsageError extends Error {}

const FLAGS_WITH_VALUES = [
  "--state",
  "--turn",
  "--model",
  "--threshold",
  "--price",
  "--timeout",
  "--cases",
  "--concurrency",
  "--cache",
  "--max-cost",
  "--min-accuracy",
  "--compare",
  "--target-accuracy",
];

/**
 * Read the flags after a subcommand. `--flag value` and `--flag=value` both work, and the first
 * bare word is the file — a page is a path, not a flag, so there is only ever one.
 */
function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    file: "-",
    turns: [],
    threshold: 0.5,
    mock: false,
    json: false,
    concurrency: 4,
    failOnRegression: false,
    calibrate: false,
    rates: cost.ratesFromEnv(env[cost.PRICE_ENV]),
  };
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith("--") && eq > 0 ? arg.slice(eq + 1) : undefined;
    const valueOf = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${name} needs a value.`);
      return next;
    };
    switch (name) {
      case "--state":
        options.state = valueOf();
        break;
      case "--turn":
        options.turns.push(valueOf());
        break;
      case "--model":
        options.model = valueOf();
        break;
      case "--threshold": {
        const value = Number(valueOf());
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new UsageError("--threshold takes a number from 0 to 1.");
        }
        options.threshold = value;
        break;
      }
      case "--price": {
        const rates = cost.parseRates(valueOf());
        if (!rates.ok) throw new UsageError(rates.error);
        options.rates = rates.value;
        break;
      }
      case "--timeout": {
        const seconds = Number(valueOf());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          throw new UsageError("--timeout takes a number of seconds greater than 0.");
        }
        options.timeoutMs = Math.round(seconds * 1000);
        break;
      }
      case "--cases":
        options.cases = valueOf();
        break;
      case "--concurrency": {
        const workers = Number(valueOf());
        if (!Number.isInteger(workers) || workers < 1) {
          throw new UsageError("--concurrency takes a whole number of 1 or more.");
        }
        options.concurrency = workers;
        break;
      }
      case "--cache":
        options.cache = valueOf();
        break;
      case "--max-cost": {
        const dollars = Number(valueOf());
        if (!Number.isFinite(dollars) || dollars <= 0) {
          throw new UsageError("--max-cost takes a number of dollars greater than 0.");
        }
        options.maxCost = dollars;
        break;
      }
      case "--min-accuracy": {
        const bar = Number(valueOf());
        if (!Number.isFinite(bar) || bar < 0 || bar > 1) {
          throw new UsageError("--min-accuracy takes a number from 0 to 1.");
        }
        options.minAccuracy = bar;
        break;
      }
      case "--compare":
        options.compare = valueOf();
        break;
      case "--fail-on-regression":
        options.failOnRegression = true;
        break;
      case "--calibrate":
        options.calibrate = true;
        break;
      case "--target-accuracy": {
        const target = Number(valueOf());
        if (!Number.isFinite(target) || target < 0 || target > 1) {
          throw new UsageError("--target-accuracy takes a number from 0 to 1.");
        }
        options.targetAccuracy = target;
        break;
      }
      case "--mock":
        options.mock = true;
        break;
      case "--json":
        options.json = true;
        break;
      default:
        if (name.startsWith("-") && name !== "-") {
          throw new UsageError(`unknown option ${name}. jev --help lists them.`);
        }
        if (file !== undefined) {
          throw new UsageError(
            `expected one file, got ${JSON.stringify(file)} and ${JSON.stringify(arg)}.`,
          );
        }
        file = arg;
    }
  }
  if (file !== undefined) options.file = file;
  return options;
}

/**
 * The flags `eval` reads differently from the other commands.
 *
 * `--state` is the interesting one: a page's state is what the cases replace, so passing one would
 * quietly judge the same text forty times. `--turn` is the same thing said a turn at a time — a
 * case that is a conversation carries its turns in its own `state`.
 */
function checkEvalOptions(options: Options): void {
  if (options.state !== undefined) {
    throw new UsageError("--state does not apply to eval: the cases carry the states.");
  }
  if (options.turns.length > 0) {
    throw new UsageError("--turn does not apply to eval: a case's own state carries its turns.");
  }
  if (options.cases === undefined) {
    throw new UsageError("--cases <file> is required: jev eval page.jev --cases cases.jsonl");
  }
  if (options.cases === "-" && options.file === "-") {
    throw new UsageError("the page and the cases cannot both come from stdin.");
  }
  if (options.maxCost !== undefined && options.rates === undefined) {
    throw new UsageError("--max-cost needs rates: pass --price <in>/<out> or set JEV_PRICE.");
  }
  if (options.compare === "-" && (options.file === "-" || options.cases === "-")) {
    throw new UsageError("only one of the page, --compare and --cases can come from stdin.");
  }
  if (options.failOnRegression && options.compare === undefined) {
    throw new UsageError("--fail-on-regression needs --compare: there is nothing to regress from.");
  }
  if (options.calibrate && options.compare !== undefined) {
    throw new UsageError("--calibrate and --compare do not mix: calibrate one page at a time.");
  }
  if (options.calibrate && options.file === "-") {
    throw new UsageError(
      "--calibrate writes the page back, so the page has to be a file, not stdin.",
    );
  }
  if (options.targetAccuracy !== undefined && !options.calibrate) {
    throw new UsageError("--target-accuracy only applies with --calibrate.");
  }
}

/** The page: a file, or everything on stdin when the path is `-`. */
function readInput(path: string): string {
  try {
    return readFileSync(path === "-" ? 0 : path, "utf8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      path === "-" ? `could not read stdin: ${reason}` : `could not read ${path}: ${reason}`,
    );
  }
}

/** Simulated answers for a case, the same deterministic ones `jev run --mock` prints. */
function mockAsk(session: Session): Promise<evaluate.Outcome> {
  return Promise.resolve({ ok: true, answers: headless.mockAnswers(session) });
}

/** The cache key: the request body this case would POST, hashed. */
function cacheKey(session: Session, model: string): string {
  const body = compact({ state: session.state, model, questions: session.questionsJson() });
  return createHash("sha256").update(body).digest("hex");
}

/** A cached response, or `undefined` when there is none this run can use. */
function cached(file: string, session: Session): evaluate.Outcome | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const decoded = decodeSystemOne(text);
    const response = makeSystemOneResponse(
      decoded.model,
      decoded.usage,
      decoded.answers,
      decoded.raw,
      {
        status: 200,
        headers: {},
        attempts: 0,
      },
    );
    return { ok: true, answers: headless.liveAnswers(session, response), usage: response.usage };
  } catch {
    // A file this version cannot read is not worth failing a case over; send the request instead.
    return undefined;
  }
}

/** One live call per case, through the cache when there is one. */
function liveAsk(
  client: Client,
  model: string,
  options: Options,
): (session: Session) => Promise<evaluate.Outcome> {
  const call =
    options.timeoutMs === undefined ? { model } : { model, timeoutMs: options.timeoutMs };
  const dir = options.cache;
  return async (session) => {
    const file = dir === undefined ? undefined : join(dir, `${cacheKey(session, model)}.json`);
    if (file !== undefined) {
      const hit = cached(file, session);
      if (hit !== undefined) return hit;
    }
    try {
      const response = await client.systemOne(session.state, session.questions, call);
      if (file !== undefined) writeFileSync(file, `${pretty(response.raw)}\n`);
      return { ok: true, answers: headless.liveAnswers(session, response), usage: response.usage };
    } catch (e) {
      return { ok: false, error: linesText(errorLines(e)).trim() };
    }
  };
}

/**
 * `jev eval`: the page over a file of labelled states, scored.
 *
 * The order matters. Nothing is sent until the cases have parsed and the estimate has been shown,
 * because a cases file is the one input that turns a typo into a bill.
 */
async function runEval(
  session: Session,
  page: string,
  options: Options,
  model: string,
  client: Client | undefined,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  let text: string;
  try {
    text = readInput(options.cases as string);
  } catch (e) {
    err(`jev eval: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  if (options.compare !== undefined) {
    return runEvalCompare(session, text, options, model, client, out, err);
  }
  const parsed = evaluate.parseCases(text, session);
  if (!parsed.ok) {
    err(`jev eval: ${parsed.error}\n`);
    return 1;
  }
  const cases = parsed.value;

  if (client !== undefined) {
    const estimate = evaluate.preflight(session, cases, model, options.rates);
    const n = estimate.cases;
    const stop = beforeSending(`${n} case${n === 1 ? "" : "s"}`, [estimate], options, err);
    if (stop !== undefined) return stop;
  }

  const ask = client === undefined ? mockAsk : liveAsk(client, model, options);
  const outcomes = await evaluate.run(session, cases, ask, options.concurrency);
  const report = evaluate.report(session, cases, outcomes, {
    model,
    threshold: options.threshold,
    rates: options.rates,
  });
  let code = report.errors.length > 0 ? 1 : 0;

  // Calibration writes before it prints, so the report never claims a file it failed to write.
  const calibration =
    options.calibrate && report.errors.length === 0
      ? evaluate.calibrate(
          session,
          cases,
          outcomes,
          report,
          options.targetAccuracy ?? evaluate.DEFAULT_TARGET,
        )
      : undefined;
  let written = true;
  if (calibration !== undefined && calibration.changed.size > 0) {
    try {
      writeFileSync(options.file, sketch.setBars(page, calibration.changed));
    } catch (e) {
      err(`jev eval: could not write ${options.file}: ${e instanceof Error ? e.message : e}\n`);
      written = false;
      code = 1;
    }
  }
  const shown = written ? calibration : undefined;

  if (options.json) {
    const json = evaluate.reportJson(report) as JsonObject;
    if (shown !== undefined) json["calibration"] = evaluate.calibrationJson(shown, options.file);
    out(`${pretty(json)}\n`);
  } else {
    const lines = evaluate.reportLines(report);
    if (shown !== undefined)
      lines.push(blankLine(), ...evaluate.calibrationLines(shown, options.file));
    out(`${linesText(lines)}\n`);
  }
  if (client === undefined) {
    err(
      "Simulated answers: deterministic noise, not judgement. Set TYPESAFE_API_KEY for real ones.\n",
    );
  }
  if (options.calibrate && report.errors.length > 0) {
    err(`jev eval: ${evaluate.notCalibrating(report.errors.length)}\n`);
  }

  const bar = options.minAccuracy;
  if (bar !== undefined) {
    for (const [name, accuracy] of evaluate.belowBar(report, bar)) {
      err(`jev eval: ${name} accuracy ${accuracy.toFixed(2)} is below ${bar.toFixed(2)}.\n`);
      code = 1;
    }
  }
  return code;
}

/** What a page is called in a comparison: the path it came from, or stdin. */
function labelOf(path: string): string {
  return path === "-" ? "stdin" : path;
}

type Preflight = ReturnType<typeof evaluate.preflight>;

/**
 * The live preflight: say what the run is about to cost, refuse it above `--max-cost`, and make
 * the cache directory. Returns the exit status to stop with, or `undefined` to go on and send.
 */
function beforeSending(
  what: string,
  estimates: readonly Preflight[],
  options: Options,
  err: (text: string) => void,
): number | undefined {
  const inputTokens = estimates.reduce((sum, one) => sum + one.inputTokens, 0);
  const outputTokens = estimates.reduce((sum, one) => sum + one.outputTokens, 0);
  const rates = options.rates;
  const total =
    rates === undefined ? undefined : cost.price(inputTokens, outputTokens, rates).total;
  const money =
    total === undefined || rates === undefined
      ? ""
      : `, ≈ ${cost.usd(total)} at ${cost.formatRates(rates)}`;
  err(`jev eval: ${what}, ≈ ${inputTokens} in / ${outputTokens} out tokens${money}\n`);
  if (options.maxCost !== undefined && total !== undefined && total > options.maxCost) {
    err(
      `jev eval: refusing to send: ≈ ${cost.usd(total)} is above --max-cost ${cost.usd(options.maxCost)}.\n`,
    );
    return 1;
  }
  if (options.cache !== undefined) {
    try {
      mkdirSync(options.cache, { recursive: true });
    } catch (e) {
      err(`jev eval: could not use ${options.cache}: ${e instanceof Error ? e.message : e}\n`);
      return 1;
    }
  }
  return undefined;
}

/**
 * `jev eval --compare`: two pages over the same cases, and whether the difference is real.
 *
 * Everything that costs money is shared — one preflight over both pages, one pool of workers, one
 * cache — so comparing two pages costs what running them both costs and nothing more.
 */
async function runEvalCompare(
  a: Session,
  text: string,
  options: Options,
  modelA: string,
  client: Client | undefined,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  const labels = { a: labelOf(options.file), b: labelOf(options.compare as string) };
  let second: string;
  try {
    second = readInput(options.compare as string);
  } catch (e) {
    err(`jev eval: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const loaded = headless.load(second);
  if (!loaded.ok) {
    err(`jev eval: ${labels.b}: ${loaded.error}\n`);
    return 1;
  }
  const b = loaded.value;
  if (options.model !== undefined) b.model = options.model;
  const modelB = b.model ?? client?.defaultModel ?? "jev-latest";

  const parsed = evaluate.parseCompareCases(text, a, b, labels);
  if (!parsed.ok) {
    err(`jev eval: ${parsed.error}\n`);
    return 1;
  }
  const [casesA, casesB] = parsed.value;

  if (client !== undefined) {
    const estimates = [
      evaluate.preflight(a, casesA, modelA, undefined),
      evaluate.preflight(b, casesB, modelB, undefined),
    ];
    const what = `${casesA.length} + ${casesB.length} cases over two pages`;
    const stop = beforeSending(what, estimates, options, err);
    if (stop !== undefined) return stop;
  }

  const askA = client === undefined ? mockAsk : liveAsk(client, modelA, options);
  const askB = client === undefined ? mockAsk : liveAsk(client, modelB, options);
  const [outcomesA, outcomesB] = await evaluate.runCompare(
    { session: a, cases: casesA, ask: askA },
    { session: b, cases: casesB, ask: askB },
    options.concurrency,
  );
  const comparison = evaluate.compare(
    { label: labels.a, session: a, cases: casesA, outcomes: outcomesA, model: modelA },
    { label: labels.b, session: b, cases: casesB, outcomes: outcomesB, model: modelB },
    { threshold: options.threshold, rates: options.rates },
  );
  if (options.json) out(`${pretty(evaluate.compareJson(comparison))}\n`);
  else out(`${linesText(evaluate.compareLines(comparison))}\n`);
  if (client === undefined) {
    err(
      "Simulated answers: deterministic noise, not judgement. Set TYPESAFE_API_KEY for real ones.\n",
    );
  }

  const sides = [comparison.a, comparison.b];
  let code = sides.some((side) => side.report.errors.length > 0) ? 1 : 0;
  const bar = options.minAccuracy;
  if (bar !== undefined) {
    for (const side of sides) {
      for (const [name, accuracy] of evaluate.belowBar(side.report, bar)) {
        err(
          `jev eval: ${side.label}: ${name} accuracy ${accuracy.toFixed(2)} is below ${bar.toFixed(2)}.\n`,
        );
        code = 1;
      }
    }
  }
  if (options.failOnRegression) {
    for (const question of evaluate.regressions(comparison)) {
      err(
        `jev eval: ${question.name} is significantly worse in ${labels.b} (McNemar p ${question.mcnemar.p.toFixed(3)}).\n`,
      );
      code = 1;
    }
  }
  return code;
}

/** One shot: read a page, print one thing, say whether it worked. */
async function runCommand(
  command: Command,
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (text: string) => void,
): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv, env);
    if (command === "eval") checkEvalOptions(options);
  } catch (e) {
    err(`jev ${command}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  let text: string;
  try {
    text = readInput(options.file);
  } catch (e) {
    err(`jev ${command}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  if (command === "check") {
    const checked = headless.checkText(text);
    if (!checked.ok) {
      err(`${checked.error}\n`);
      return 1;
    }
    out(`${checked.value}\n`);
    return 0;
  }

  const loaded = headless.load(text);
  if (!loaded.ok) {
    err(`jev ${command}: ${loaded.error}\n`);
    return 1;
  }
  const session = loaded.value;
  if (options.state !== undefined) session.state = options.state;
  for (const text of options.turns) {
    const turn = parseTurn(text);
    if (!turn.ok) {
      err(`jev ${command}: --turn ${turn.error}\n`);
      return 2;
    }
    const added = session.addTurn(turn.value);
    if (!added.ok) {
      err(`jev ${command}: --turn ${added.error}\n`);
      return 2;
    }
  }
  if (options.model !== undefined) session.model = options.model;

  // A key makes the model name the client's default; without one the published default stands.
  const apiKey = env[API_KEY_ENV];
  const live = !options.mock && apiKey !== undefined && apiKey !== "";
  let client: Client | undefined;
  if (live) {
    try {
      client = new Client({ apiKey });
    } catch (e) {
      err(`${linesText(errorLines(e))}\n`);
      return 1;
    }
  }
  const model = session.model ?? client?.defaultModel ?? "jev-latest";

  if (command === "eval") {
    if (options.calibrate && text.trimStart().startsWith("{")) {
      err("jev eval: --calibrate needs a .jev page: a request body has nowhere to keep a bar.\n");
      return 1;
    }
    return runEval(session, text, options, model, client, out, err);
  }

  switch (command) {
    case "json":
      out(headless.requestText(session, model));
      return 0;
    case "cost":
      out(headless.costText(session, model, options.rates));
      return 0;
    case "ts":
    case "rust":
      out(headless.codeText(session, command, model, options.threshold));
      return 0;
    case "run":
      break;
  }

  const why = headless.sendable(session);
  if (why !== undefined) {
    err(`jev run: ${why}\n`);
    return 1;
  }

  if (client === undefined) {
    const answers = headless.mockAnswers(session);
    if (options.json) out(headless.answersJson(answers, model));
    else {
      out(headless.answersText(answers, options.threshold, session));
      out(headless.usageText(session, model, options.rates, undefined));
      err(
        "Simulated answers: deterministic noise, not judgement. Set TYPESAFE_API_KEY for real ones.\n",
      );
    }
    return 0;
  }

  const call =
    options.timeoutMs === undefined ? { model } : { model, timeoutMs: options.timeoutMs };
  try {
    const response = await client.systemOne(session.state, session.questions, call);
    const answers = headless.liveAnswers(session, response);
    if (options.json) out(headless.answersJson(answers, model, response.raw));
    else {
      out(headless.answersText(answers, options.threshold, session));
      out(headless.usageText(session, model, options.rates, response.usage));
    }
    return 0;
  } catch (e) {
    err(`${linesText(errorLines(e))}\n`);
    return 1;
  }
}

/**
 * One live call for an MCP tool, with the page's own model when it pins one.
 *
 * `jev run` resolves the model once, on the command line; a server answers pages it has never
 * seen, so each one gets to say what it should be asked with.
 */
function mcpAsk(
  client: Client,
  fallback: string,
  timeoutMs: number | undefined,
): (session: Session) => Promise<Sent> {
  return async (session) => {
    const model = session.model ?? fallback;
    const call = timeoutMs === undefined ? { model } : { model, timeoutMs };
    try {
      const response = await client.systemOne(session.state, session.questions, call);
      return {
        ok: true,
        answers: headless.liveAnswers(session, response),
        usage: response.usage,
        raw: response.raw,
      };
    } catch (e) {
      return { ok: false, error: linesText(errorLines(e)).trim() };
    }
  };
}

/** `jev mcp`: the one-shot commands again, this time as tools an agent can call. */
async function runMcp(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  err: (text: string) => void,
): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv, env);
    if (options.file !== "-") {
      throw new UsageError("jev mcp takes no file: the pages arrive in the tool calls.");
    }
    if (options.state !== undefined || options.turns.length > 0 || options.cases !== undefined) {
      throw new UsageError("--state, --turn and --cases belong to a tool call, not to the server.");
    }
  } catch (e) {
    err(`jev mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }

  const apiKey = env[API_KEY_ENV];
  const live = !options.mock && apiKey !== undefined && apiKey !== "";
  let client: Client | undefined;
  if (live) {
    try {
      client = new Client({ apiKey });
    } catch (e) {
      err(`${linesText(errorLines(e))}\n`);
      return 1;
    }
  }
  const model = options.model ?? client?.defaultModel ?? "jev-latest";
  const host: Host = {
    version: VERSION,
    model,
    live: client !== undefined,
    rates: options.rates,
    ask:
      client === undefined
        ? (session) => Promise.resolve({ ok: true, answers: headless.mockAnswers(session) } as Sent)
        : mcpAsk(client, model, options.timeoutMs),
  };

  // stdout carries the protocol and nothing else, so the greeting goes to stderr.
  err(
    `jev mcp ${VERSION}: ${host.live ? `live, model ${model}` : "no API key — every answer is simulated"}\n`,
  );
  await serve(host);
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const first = argv[0];
  if (first === "mcp") {
    return runMcp(argv.slice(1), process.env, (text) => process.stderr.write(text));
  }
  if (first === "install") {
    return install.runInstall(
      argv.slice(1),
      process.env,
      (text) => process.stdout.write(text),
      (text) => process.stderr.write(text),
    );
  }
  if (first !== undefined && headless.isCommand(first)) {
    return runCommand(
      first,
      argv.slice(1),
      process.env,
      (text) => process.stdout.write(text),
      (text) => process.stderr.write(text),
    );
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (first !== undefined) {
    process.stderr.write(`jev: unknown command ${JSON.stringify(first)}. jev --help lists them.\n`);
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "jev needs an interactive terminal (stdin and stdout must be a TTY).\n" +
        "Without one, `jev run <file>` sends a saved page and prints the answers; jev --help lists the rest.\n",
    );
    return 1;
  }

  const terminal = new Terminal();
  const queue: Msg[] = [];
  let wake: (() => void) | undefined;
  const send = (msg: Msg): void => {
    queue.push(msg);
    wake?.();
  };

  const app = new App(send);
  // Ticks only matter while the spinner is turning; otherwise an idle REPL redraws nothing.
  const ticker = setInterval(() => {
    if (app.pending) send({ kind: "tick" });
  }, 120);
  ticker.unref?.();

  terminal.start(
    (event) => send({ kind: "key", event }),
    () => send({ kind: "tick" }),
  );

  const draw = (): void => {
    const buffer = terminal.frame();
    const cursor = render(buffer, app);
    terminal.draw(buffer, cursor);
  };

  try {
    draw();
    for (;;) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
        continue;
      }
      const msg = queue.shift() as Msg;
      app.handle(msg);
      if (app.quit) break;
      if (queue.length === 0) draw();
    }
  } finally {
    clearInterval(ticker);
    terminal.stop();
  }
  return 0;
}

/**
 * Whether this module is the program being run.
 *
 * npm installs the binary as a symlink in `node_modules/.bin`, so `argv[1]` is that link while
 * `import.meta.url` is the file it points at: both have to be resolved before comparing.
 */
const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
