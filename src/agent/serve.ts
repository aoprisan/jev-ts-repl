/**
 * The MCP server on a pipe: newline-delimited JSON-RPC in on stdin, the same out on stdout.
 *
 * Nothing but the protocol may be written to stdout — a stray `console.log` is what breaks a
 * hand-written MCP server — so everything the server wants to say goes to stderr.
 */

import { createInterface } from "node:readline";

import type { Host } from "./mcp.js";
import { handleLine } from "./mcp.js";

/**
 * Answer messages until stdin closes.
 *
 * Requests are answered as they finish rather than in the order they arrived: a `jev_eval` over a
 * hundred cases must not hold up the `jev_check` behind it, and JSON-RPC matches replies by id.
 */
export function serve(
  host: Host,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
  log: (text: string) => void = (text) => process.stderr.write(text),
): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();

  lines.on("line", (line) => {
    const task = handleLine(line, host)
      .then((answer) => {
        if (answer !== undefined) output.write(`${answer}\n`);
      })
      .catch((e: unknown) => {
        // A failure this far out is a bug in the server, not in the message; say so and stay up.
        log(`jev mcp: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      })
      .finally(() => {
        pending.delete(task);
      });
    pending.add(task);
  });

  return new Promise((done) => {
    lines.on("close", () => {
      void Promise.allSettled([...pending]).then(() => {
        done();
      });
    });
  });
}
