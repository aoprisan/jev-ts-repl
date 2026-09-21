/**
 * `jev-repl` — a terminal REPL for shaping TypeSafe AI System One requests, plus the small typed
 * client it drives.
 *
 * ```ts
 * import { Client, choice, noul, score } from "jev-repl";
 *
 * const client = Client.fromEnv(); // TYPESAFE_API_KEY
 * const res = await client.systemOne("The payout failed again, third time this month.", {
 *   is_urgent: noul("The message conveys urgency"),
 *   department: choice("Which team should handle this", {
 *     billing: "Payment or subscription issues",
 *     technical: "Bugs or integration problems",
 *   }),
 *   frustration: score("How frustrated the customer is", ["Calm", "Annoyed", "Furious"]),
 * });
 * console.log(res.noul("is_urgent")?.noul);
 * ```
 *
 * Everything the REPL is made of is exported too, so a session can be driven without a terminal.
 */

// The client: questions, answers, errors, retries.
export * from "./typesafe/index.js";

// JSON helpers the question and answer shapes are built from.
export type { Json, JsonObject } from "./json.js";
export { compact, isEmptyValue, isObject, pretty, textOf } from "./json.js";

// The agent side: MCP over stdio, and installing both into a coding agent.
export * as install from "./agent/install.js";
export type {
  ClientId,
  ClientSpec,
  Kind as InstallKind,
  Scope as InstallScope,
  Server as McpServerEntry,
  Target as InstallTarget,
} from "./agent/install.js";
export * as installer from "./agent/installer.js";
export * as mcp from "./agent/mcp.js";
export type { Host as McpHost, Result as McpResult, Sent, Tool as McpTool } from "./agent/mcp.js";
export { serve } from "./agent/serve.js";
export { SKILL_FILE, SKILL_MD, SKILL_NAME } from "./agent/skill.js";

// The REPL itself.
export { App, COMMANDS } from "./repl/app.js";
export type { Msg } from "./repl/app.js";
export { Builder } from "./repl/builder.js";
export { KINDS, seed } from "./repl/seeds.js";
export type { Field, Kind, Outcome as BuilderOutcome } from "./repl/builder.js";
export * as codegen from "./repl/codegen.js";
export * as cost from "./repl/cost.js";
export type { Cost, Estimate, QuestionEstimate, Rates } from "./repl/cost.js";
export { Editor, PREVIEWS } from "./repl/editor.js";
export type { Outcome as EditorOutcome, Preview } from "./repl/editor.js";
export * as evaluate from "./repl/evaluate.js";
export type { Case, Expectation, Outcome, Report } from "./repl/evaluate.js";
export * as format from "./repl/format.js";
export * as headless from "./repl/headless.js";
export type { Answered, Command as HeadlessCommand } from "./repl/headless.js";
export * as highlight from "./repl/highlight.js";
export { LESSONS } from "./repl/lessons.js";
export type { Lesson } from "./repl/lessons.js";
export * as mock from "./repl/mock.js";
export { find as findPreset, PRESETS } from "./repl/presets.js";
export type { Preset } from "./repl/presets.js";
export {
  fromBody,
  parseChoice,
  parseNoul,
  parseRaw,
  parseScore,
  Session,
  value as parseValue,
} from "./repl/session.js";
export type { Entry, Parsed } from "./repl/session.js";
export * as sketch from "./repl/sketch.js";
export { render } from "./repl/ui.js";
export type { Cursor } from "./repl/ui.js";
export * as wrap from "./repl/wrap.js";

// The terminal pieces, so the REPL can be embedded or screenshotted.
export { Buffer } from "./tui/buffer.js";
export * as layout from "./tui/layout.js";
export { char, ctrl, decodeOne, isCtrl, key, KeyDecoder } from "./tui/keys.js";
export type { KeyCode, KeyEvent } from "./tui/keys.js";
export { blankLine, line, lineText, linesText, patchStyle, span, lineWidth } from "./tui/style.js";
export type { Color, Line, Span, Style } from "./tui/style.js";
export { Terminal } from "./tui/terminal.js";
export { isDeleteWordLeft, isWordLeft, isWordRight, wordLeft, wordRight } from "./tui/words.js";

// The CLI entry point, for embedding `jev` in another binary.
export { main } from "./cli.js";
