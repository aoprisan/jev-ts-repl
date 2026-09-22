/**
 * The parts of jev that do not need a terminal: the notation, the session, the offline answers,
 * the code generators and the typed client. Everything here runs unchanged in a browser — no
 * `node:` imports, no `process`, no stdin — which is what the web REPL under `web/` is built on.
 *
 * ```ts
 * import { sketch, mock, codegen } from "jev-repl/core";
 *
 * const page = sketch.parse("A payout failed.\n---\nis_urgent? Conveys urgency");
 * const session = page.toSession();
 * console.log(session.requestJson("jev-latest"));
 * console.log(codegen.typescript(session, "jev-latest", 0.5));
 * ```
 *
 * The terminal REPL, which adds the TUI and the file commands, stays on the package root export.
 */

// The client: questions, answers, errors, retries.
export * from "./typesafe/index.js";

// JSON helpers the question and answer shapes are built from.
export type { Json, JsonObject } from "./json.js";
export { compact, isEmptyValue, isObject, pretty, textOf } from "./json.js";

// A blank question of each kind, for a front end that adds one.
export { KINDS, seed } from "./repl/seeds.js";
export type { Kind } from "./repl/seeds.js";

// The session: what a request is made of, and the one-line commands that build it.
export {
  fromBody,
  parseChoice,
  parseNoul,
  parseRaw,
  parseScore,
  parseTurn,
  Session,
  turnsOf,
  turnsToJson,
  turnText,
  value as parseValue,
} from "./repl/session.js";
export type { Entry, Parsed, Turn } from "./repl/session.js";

// Sketch notation: parse a page, render a session back to one, highlight it.
export * as sketch from "./repl/sketch.js";

// Offline answers, code generation, the ready-made sessions and the guided track.
export * as codegen from "./repl/codegen.js";
export * as cost from "./repl/cost.js";
export type { Cost, Estimate, QuestionEstimate, Rates, Thread } from "./repl/cost.js";
export * as evaluate from "./repl/evaluate.js";
export type { Case, Comparison, Expectation, Outcome, Report } from "./repl/evaluate.js";
export * as headless from "./repl/headless.js";
export type { Answered, Command as HeadlessCommand } from "./repl/headless.js";
export * as mock from "./repl/mock.js";
export { find as findPreset, PRESETS } from "./repl/presets.js";
export type { Preset } from "./repl/presets.js";
export { LESSONS } from "./repl/lessons.js";
export type { Lesson } from "./repl/lessons.js";

// The agent side: the MCP server's protocol half, and where an agent's files go.
export * as mcp from "./agent/mcp.js";
export type { Host as McpHost, Result as McpResult, Sent, Tool as McpTool } from "./agent/mcp.js";
export * as install from "./agent/install.js";
export type {
  ClientId,
  ClientSpec,
  Kind as InstallKind,
  Scope as InstallScope,
  Server as McpServerEntry,
  Target as InstallTarget,
} from "./agent/install.js";
export { SKILL_FILE, SKILL_MD, SKILL_NAME } from "./agent/skill.js";

// Answer formatting, shared by every host: the same bars and labels the terminal draws.
export * as format from "./repl/format.js";
export * as highlight from "./repl/highlight.js";
export * as wrap from "./repl/wrap.js";

// Styled text — what `format`, `highlight` and `sketch.highlight` return.
export { blankLine, line, lineText, linesText, lineWidth, patchStyle, span } from "./tui/style.js";
export type { Color, Line, Span, Style } from "./tui/style.js";
