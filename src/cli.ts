#!/usr/bin/env node
/**
 * `jev` — an interactive playground for learning TypeSafe AI System One questions.
 *
 * Run it with a `TYPESAFE_API_KEY` for live answers, or without one to explore offline with
 * simulated answers. `:help` inside lists every command; `:lesson` starts the guided track.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { App } from "./repl/app.js";
import type { Msg } from "./repl/app.js";
import { render } from "./repl/ui.js";
import { Terminal } from "./tui/terminal.js";
import { VERSION } from "./typesafe/constants.js";

const HELP = `jev — a REPL for TypeSafe AI System One questions

Set TYPESAFE_API_KEY for live answers; without one, answers are simulated locally.
Inside: :help for commands, :lesson for the guided track, :sketch to write a request
as one page of text, :quit to leave.

  --help, -h       this message
  --version, -v    the version of this package
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write("jev needs an interactive terminal (stdin and stdout must be a TTY).\n");
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
