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

import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { App } from "./repl/app.js";
import type { Msg } from "./repl/app.js";
import * as cost from "./repl/cost.js";
import type { Command } from "./repl/headless.js";
import * as headless from "./repl/headless.js";
import { errorLines } from "./repl/format.js";
import { render } from "./repl/ui.js";
import { Terminal } from "./tui/terminal.js";
import { linesText } from "./tui/style.js";
import { Client } from "./typesafe/client.js";
import { API_KEY_ENV, VERSION } from "./typesafe/constants.js";

const HELP = `jev — a REPL for TypeSafe AI System One questions

Set TYPESAFE_API_KEY for live answers; without one, answers are simulated locally.

  jev                    the REPL: :help for commands, :lesson for the guided track,
                         :sketch to write a request as one page, :quit to leave
  jev <command> [file]   one shot, no terminal needed

Commands
${headless.COMMANDS.map(([name, about]) => `  ${name.padEnd(22)} ${about}`).join("\n")}

The file is a .jev sketch page or a request body; \`-\`, or no file at all, reads stdin.

Options
  --state <text>         set the state, or replace the one on the page
  --model <name>         the model to ask
  --threshold <0-1>      what counts as a yes for a noul (default 0.5)
  --price <in>/<out>     dollars per million tokens, input then output
  --timeout <seconds>    per-attempt timeout for a live call
  --mock                 simulated answers, even when a key is set
  --json                 print the raw response body instead of the answer page
  --help, -h             this message
  --version, -v          the version of this package

Exit status is 0 when it worked, 1 when the call or the file did not, 2 when the
command line did not parse.
`;

/** Everything the one-shot commands read off the command line. */
interface Options {
  file: string;
  state?: string;
  model?: string;
  threshold: number;
  rates?: cost.Rates;
  timeoutMs?: number;
  mock: boolean;
  json: boolean;
}

/** A usage error: the command line itself did not make sense. */
class UsageError extends Error {}

const FLAGS_WITH_VALUES = ["--state", "--model", "--threshold", "--price", "--timeout"];

/**
 * Read the flags after a subcommand. `--flag value` and `--flag=value` both work, and the first
 * bare word is the file — a page is a path, not a flag, so there is only ever one.
 */
function parseOptions(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const options: Options = {
    file: "-",
    threshold: 0.5,
    mock: false,
    json: false,
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
      out(headless.answersText(answers, options.threshold));
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
      out(headless.answersText(answers, options.threshold));
      out(headless.usageText(session, model, options.rates, response.usage));
    }
    return 0;
  } catch (e) {
    err(`${linesText(errorLines(e))}\n`);
    return 1;
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const first = argv[0];
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
