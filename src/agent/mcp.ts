/**
 * jev as an MCP server: the one-shot commands, offered to an agent as tools.
 *
 * This half is pure — a JSON-RPC message in, a JSON-RPC message out — so the protocol can be
 * tested without a pipe, and the same handler serves stdio here, a socket elsewhere, or the web
 * build. Everything that touches the network goes through {@link Host}, which the caller supplies.
 *
 * ```ts
 * const reply = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, host);
 * ```
 */

import type { Json, JsonObject } from "../json.js";
import { compact, isObject, pretty } from "../json.js";
import * as cost from "../repl/cost.js";
import * as evaluate from "../repl/evaluate.js";
import { errorLines } from "../repl/format.js";
import * as headless from "../repl/headless.js";
import * as presets from "../repl/presets.js";
import * as sketch from "../repl/sketch.js";
import type { Session } from "../repl/session.js";
import { linesText } from "../tui/style.js";
import { SKILL_MD } from "./skill.js";

/** The protocol revision this server speaks. */
export const PROTOCOL_VERSION = "2025-06-18";

/** Revisions a client may ask for and still be understood; anything else gets ours back. */
export const KNOWN_PROTOCOLS: readonly string[] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** The name the server reports at `initialize`, and the prefix on every tool. */
export const SERVER_NAME = "jev";

/** JSON-RPC error codes, the four this server can actually raise. */
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

/** What the host does for the tools that need more than text: send a request, price it, name a model. */
export interface Host {
  /** The version reported at `initialize`. */
  readonly version: string;
  /** The model a page that pins none is sent with. */
  readonly model: string;
  /** Whether answers come from the API. False means every answer is simulated. */
  readonly live: boolean;
  /** Send one session and come back with its answers, or with why it did not. */
  ask(session: Session): Promise<Sent>;
  /** Token prices, when the host was given any. */
  readonly rates?: cost.Rates | undefined;
}

/**
 * What the host got back from one send: the same outcome `jev eval` scores, plus the raw body when
 * there was one, so `jev_ask` can hand it over for a script to read.
 */
export type Sent = evaluate.Outcome & { readonly raw?: Json };

/** What a tool call comes back with: text blocks, and whether they describe a failure. */
export interface Result {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError?: boolean;
}

/** One tool, as `tools/list` describes it. */
export interface Tool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

const PAGE_PROPERTY: JsonObject = {
  type: "string",
  description:
    "The request as a jev sketch page, or a raw /v1/systemone request body. jev_notation has the notation.",
};

const STATE_PROPERTY: JsonObject = {
  type: "string",
  description: "Judge this text instead of the state written on the page.",
};

const MODEL_PROPERTY: JsonObject = {
  type: "string",
  description: "The model to ask. Defaults to the one the page pins, then to the server's default.",
};

const THRESHOLD_PROPERTY: JsonObject = {
  type: "number",
  description: "What counts as a yes for a noul, from 0 to 1. Defaults to 0.5.",
};

const PRICE_PROPERTY: JsonObject = {
  type: "string",
  description: 'Dollars per million tokens, input then output, as "0.20/1.00".',
};

/** Every tool this server offers, in the order an agent should reach for them. */
export const TOOLS: readonly Tool[] = [
  {
    name: "jev_notation",
    title: "jev notation",
    description:
      "The jev sketch notation and workflow: how to write a page of questions, what each kind of " +
      "question answers with, and how to check, price, run and score one. Read this before " +
      "writing a page, and again when one will not parse.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "jev_check",
    title: "Check a page",
    description:
      "Parse a page and report every problem with a line number, or say what it parsed into. " +
      "Sends nothing and costs nothing — use it on every page before running one.",
    inputSchema: {
      type: "object",
      properties: { page: PAGE_PROPERTY },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_request",
    title: "Request body",
    description: "The exact JSON body this page would POST to /v1/systemone. Sends nothing.",
    inputSchema: {
      type: "object",
      properties: { page: PAGE_PROPERTY, state: STATE_PROPERTY, model: MODEL_PROPERTY },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_cost",
    title: "Estimate cost",
    description:
      "Estimated tokens for this page, per question and on both sides of the wire, priced when " +
      "rates are given. Sends nothing. Check this before a run over many cases.",
    inputSchema: {
      type: "object",
      properties: {
        page: PAGE_PROPERTY,
        state: STATE_PROPERTY,
        model: MODEL_PROPERTY,
        price: PRICE_PROPERTY,
      },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_ask",
    title: "Ask the questions",
    description:
      "Send the page and return one answer per question. Spends money when the server holds an " +
      "API key; without one every answer is simulated noise and must not be reported as judgement.",
    inputSchema: {
      type: "object",
      properties: {
        page: PAGE_PROPERTY,
        state: STATE_PROPERTY,
        model: MODEL_PROPERTY,
        threshold: THRESHOLD_PROPERTY,
        json: {
          type: "boolean",
          description: "Return the raw response body instead of the answer page.",
        },
      },
      required: ["page"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_eval",
    title: "Score a page",
    description:
      "Run a page over labelled cases and score the answers: accuracy per question, a confusion " +
      "table, a threshold sweep for each noul. One request per case, so price it first.",
    inputSchema: {
      type: "object",
      properties: {
        page: PAGE_PROPERTY,
        cases: {
          type: "string",
          description:
            'JSON Lines, one labelled state per line: {"state": "...", "expect": {"is_urgent": true}}.',
        },
        model: MODEL_PROPERTY,
        threshold: THRESHOLD_PROPERTY,
        price: PRICE_PROPERTY,
        concurrency: {
          type: "integer",
          description: "How many cases are in the air at once. Defaults to 4.",
          minimum: 1,
        },
        compare: {
          type: "string",
          description:
            "A second page to run over the same cases. The report becomes the difference: " +
            "deltas per question, the cases whose answer flipped, and an exact McNemar test.",
        },
        calibrate: {
          type: "boolean",
          description:
            "Also return the page with the bars this run supports written in: each noul's " +
            "best-F1 @threshold, and the lowest @confidence at which a choice or score reaches " +
            "targetAccuracy. Nothing else on the page changes.",
        },
        targetAccuracy: {
          type: "number",
          description: "The accuracy a confidence bar has to reach. Defaults to 0.9.",
          minimum: 0,
          maximum: 1,
        },
        json: { type: "boolean", description: "Return the report as JSON instead of a table." },
      },
      required: ["page", "cases"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_code",
    title: "Page as code",
    description:
      "The page as a working program — TypeScript against jev-repl, or Rust against " +
      "typesafe-ai-sdk. Start here instead of writing a client by hand.",
    inputSchema: {
      type: "object",
      properties: {
        page: PAGE_PROPERTY,
        language: { type: "string", enum: ["ts", "rust"], description: "Which language to print." },
        model: MODEL_PROPERTY,
        threshold: THRESHOLD_PROPERTY,
      },
      required: ["page", "language"],
      additionalProperties: false,
    },
  },
  {
    name: "jev_presets",
    title: "Ready-made pages",
    description:
      "Worked pages to start from — support triage, content moderation, lead qualification and " +
      "reply grading — each as a sketch page ready to edit.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "One preset by name. Omit for all of them." },
      },
      additionalProperties: false,
    },
  },
];

/** A tool call that cannot run: the message says what to pass instead. */
class ArgumentError extends Error {}

const text = (body: string): Result => ({ content: [{ type: "text", text: body }] });
const failure = (body: string): Result => ({
  content: [{ type: "text", text: body }],
  isError: true,
});

function stringArg(args: JsonObject, name: string, fallback?: string): string {
  const value = args[name];
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new ArgumentError(`${name} is required.`);
  }
  if (typeof value !== "string") throw new ArgumentError(`${name} must be a string.`);
  return value;
}

function numberArg(args: JsonObject, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ArgumentError(`${name} must be a number.`);
  }
  return value;
}

function boolArg(args: JsonObject, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new ArgumentError(`${name} must be true or false.`);
  return value;
}

/** The rates a call was given, falling back to the host's. */
function ratesArg(args: JsonObject, host: Host): cost.Rates | undefined {
  const value = args["price"];
  if (value === undefined || value === null) return host.rates;
  if (typeof value !== "string") throw new ArgumentError("price must be a string.");
  const parsed = cost.parseRates(value);
  if (!parsed.ok) throw new ArgumentError(parsed.error);
  return parsed.value;
}

/** The page, loaded, with the overrides a call may carry applied. */
function sessionArg(args: JsonObject, host: Host): { session: Session; model: string } {
  const loaded = headless.load(stringArg(args, "page"));
  if (!loaded.ok) throw new ArgumentError(loaded.error);
  const session = loaded.value;
  const state = args["state"];
  if (state !== undefined && state !== null) {
    if (typeof state !== "string") throw new ArgumentError("state must be a string.");
    session.state = state;
  }
  const model = args["model"];
  if (model !== undefined && model !== null) {
    if (typeof model !== "string") throw new ArgumentError("model must be a string.");
    session.model = model;
  }
  return { session, model: session.model ?? host.model };
}

/** The line every simulated answer is stamped with, so nobody reports noise as judgement. */
const SIMULATED =
  "\nSimulated answers: deterministic noise, not judgement. " +
  "The server has no TYPESAFE_API_KEY, so nothing was sent.";

async function ask(args: JsonObject, host: Host): Promise<Result> {
  const { session, model } = sessionArg(args, host);
  const why = headless.sendable(session);
  if (why !== undefined) throw new ArgumentError(why);
  const threshold = numberArg(args, "threshold", 0.5);
  if (threshold < 0 || threshold > 1) throw new ArgumentError("threshold must be from 0 to 1.");

  const outcome = await host.ask(session);
  if (!outcome.ok) return failure(outcome.error);
  if (boolArg(args, "json", false)) {
    return text(headless.answersJson(outcome.answers, model, outcome.raw));
  }
  const body =
    headless.answersText(outcome.answers, threshold, session) +
    headless.usageText(session, model, ratesArg(args, host), outcome.usage);
  return text(host.live ? body : body + SIMULATED);
}

async function score(args: JsonObject, host: Host): Promise<Result> {
  const { session, model } = sessionArg(args, host);
  const threshold = numberArg(args, "threshold", 0.5);
  if (threshold < 0 || threshold > 1) throw new ArgumentError("threshold must be from 0 to 1.");
  const concurrency = numberArg(args, "concurrency", 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new ArgumentError("concurrency must be a whole number of 1 or more.");
  }
  const rates = ratesArg(args, host);
  const second = args["compare"];
  if (second !== undefined && second !== null) {
    return compared(args, host, session, model, threshold, concurrency, rates);
  }

  const parsed = evaluate.parseCases(stringArg(args, "cases"), session);
  if (!parsed.ok) throw new ArgumentError(parsed.error);
  const cases = parsed.value;
  if (cases.length === 0) throw new ArgumentError("cases is empty: nothing to score.");

  const calibrating = boolArg(args, "calibrate", false);
  const target = numberArg(args, "targetAccuracy", evaluate.DEFAULT_TARGET);
  if (target < 0 || target > 1) throw new ArgumentError("targetAccuracy must be from 0 to 1.");
  const page = stringArg(args, "page");
  if (calibrating && page.trimStart().startsWith("{")) {
    throw new ArgumentError(
      "calibrate needs a .jev page: a request body has nowhere to keep a bar.",
    );
  }

  const outcomes = await evaluate.run(session, cases, (one) => host.ask(one), concurrency);
  const report = evaluate.report(session, cases, outcomes, { model, threshold, rates });
  const calibration =
    calibrating && report.errors.length === 0
      ? evaluate.calibrate(session, cases, outcomes, report, target)
      : undefined;
  const calibrated = calibration && sketch.setBars(page, calibration.changed);
  const refused = calibrating && calibration === undefined;
  const why = evaluate.notCalibrating(report.errors.length);

  if (boolArg(args, "json", false)) {
    const json = evaluate.reportJson(report) as JsonObject;
    if (calibration !== undefined) {
      json["calibration"] = {
        ...evaluate.calibrationJson(calibration, "page"),
        text: calibrated ?? page,
      };
    }
    if (refused) json["calibration"] = { refused: why };
    return text(`${pretty(json)}\n`);
  }
  let body = `${linesText(evaluate.reportLines(report))}\n`;
  if (calibration !== undefined) {
    body += `\n${linesText(evaluate.calibrationLines(calibration, "the page"))}\n`;
    body += `\n# the page, calibrated\n\n${calibrated ?? page}`;
  }
  if (refused) body += `\n${why}\n`;
  return text(host.live ? body : body + SIMULATED);
}

/** `jev_eval` with `compare`: both pages over the same cases, labelled `a` and `b`. */
async function compared(
  args: JsonObject,
  host: Host,
  a: Session,
  modelA: string,
  threshold: number,
  concurrency: number,
  rates: cost.Rates | undefined,
): Promise<Result> {
  const loaded = headless.load(stringArg(args, "compare"));
  if (!loaded.ok) throw new ArgumentError(`compare: ${loaded.error}`);
  const b = loaded.value;
  // A model named in the call overrides both pages, the way --model does on the command line.
  if (typeof args["model"] === "string") b.model = args["model"];
  const modelB = b.model ?? host.model;
  const parsed = evaluate.parseCompareCases(stringArg(args, "cases"), a, b, { a: "a", b: "b" });
  if (!parsed.ok) throw new ArgumentError(parsed.error);
  const [casesA, casesB] = parsed.value;
  const ask = (one: Session): Promise<evaluate.Outcome> => host.ask(one);
  const [outcomesA, outcomesB] = await evaluate.runCompare(
    { session: a, cases: casesA, ask },
    { session: b, cases: casesB, ask },
    concurrency,
  );
  const comparison = evaluate.compare(
    { label: "a", session: a, cases: casesA, outcomes: outcomesA, model: modelA },
    { label: "b", session: b, cases: casesB, outcomes: outcomesB, model: modelB },
    { threshold, rates },
  );
  if (boolArg(args, "json", false)) return text(`${pretty(evaluate.compareJson(comparison))}\n`);
  const body = `${linesText(evaluate.compareLines(comparison))}\n`;
  return text(host.live ? body : body + SIMULATED);
}

function presetPages(args: JsonObject): Result {
  const name = args["name"];
  if (name !== undefined && name !== null) {
    if (typeof name !== "string") throw new ArgumentError("name must be a string.");
    const one = presets.find(name);
    if (!one) {
      const names = presets.PRESETS.map((p) => p.name).join(", ");
      throw new ArgumentError(`no preset ${compact(name)}; there is ${names}.`);
    }
    return text(`# ${one.name} — ${one.about}\n\n${presets.page(one)}`);
  }
  const all = presets.PRESETS.map((p) => `# ${p.name} — ${p.about}\n\n${presets.page(p)}`);
  return text(all.join("\n\n"));
}

/** Run one tool. Argument problems come back as an error result, not as a JSON-RPC failure. */
export async function call(name: string, args: JsonObject, host: Host): Promise<Result> {
  try {
    switch (name) {
      case "jev_notation":
        return text(SKILL_MD);
      case "jev_check": {
        const checked = headless.checkText(stringArg(args, "page"));
        return checked.ok ? text(checked.value) : failure(checked.error);
      }
      case "jev_request": {
        const { session, model } = sessionArg(args, host);
        return text(headless.requestText(session, model));
      }
      case "jev_cost": {
        const { session, model } = sessionArg(args, host);
        return text(headless.costText(session, model, ratesArg(args, host)));
      }
      case "jev_ask":
        return await ask(args, host);
      case "jev_eval":
        return await score(args, host);
      case "jev_code": {
        const language = stringArg(args, "language");
        if (language !== "ts" && language !== "rust") {
          throw new ArgumentError('language must be "ts" or "rust".');
        }
        const { session, model } = sessionArg(args, host);
        const threshold = numberArg(args, "threshold", 0.5);
        return text(headless.codeText(session, language, model, threshold));
      }
      case "jev_presets":
        return presetPages(args);
      default:
        return failure(`No tool named ${compact(name)}. tools/list has them.`);
    }
  } catch (e) {
    if (e instanceof ArgumentError) return failure(`${name}: ${e.message}`);
    return failure(linesText(errorLines(e)).trim());
  }
}

const reply = (id: Json, result: Json): JsonObject => ({ jsonrpc: "2.0", id, result });

const fault = (id: Json, code: number, message: string): JsonObject => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

/** What `initialize` answers with: what we speak, what we can do, who we are. */
function greeting(params: JsonObject, host: Host): JsonObject {
  const asked = params["protocolVersion"];
  const version =
    typeof asked === "string" && KNOWN_PROTOCOLS.includes(asked) ? asked : PROTOCOL_VERSION;
  return {
    protocolVersion: version,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: SERVER_NAME, title: "jev", version: host.version },
    instructions:
      "jev shapes and sends TypeSafe AI System One questions. Call jev_notation first to learn " +
      "the page notation, jev_check to make sure a page parses, jev_cost before anything large, " +
      "then jev_ask or jev_eval." +
      (host.live ? "" : " This server has no API key: every answer is simulated."),
  };
}

/**
 * Answer one JSON-RPC message.
 *
 * Returns `undefined` for a notification — a message with no `id` gets no reply, which is the one
 * rule of the protocol that a hand-written server usually gets wrong.
 */
export async function handle(message: Json, host: Host): Promise<Json | undefined> {
  if (!isObject(message)) return fault(null, INVALID_REQUEST, "Expected a JSON-RPC object.");
  const id = message["id"];
  const method = message["method"];
  const notification = id === undefined || id === null;
  if (typeof method !== "string") {
    return notification ? undefined : fault(id as Json, INVALID_REQUEST, "No method named.");
  }
  const params = isObject(message["params"]) ? message["params"] : {};

  if (notification) {
    // Nothing this server keeps state for; the handshake's `initialized` is the usual one.
    return undefined;
  }

  switch (method) {
    case "initialize":
      return reply(id as Json, greeting(params, host));
    case "ping":
      return reply(id as Json, {});
    case "tools/list":
      return reply(id as Json, { tools: TOOLS as unknown as Json });
    case "tools/call": {
      const name = params["name"];
      if (typeof name !== "string") {
        return fault(id as Json, INVALID_PARAMS, "tools/call needs a tool name.");
      }
      const args = isObject(params["arguments"]) ? params["arguments"] : {};
      const result = await call(name, args, host);
      return reply(id as Json, result as unknown as Json);
    }
    case "resources/list":
      return reply(id as Json, { resources: [] });
    case "prompts/list":
      return reply(id as Json, { prompts: [] });
    default:
      return fault(id as Json, METHOD_NOT_FOUND, `Unknown method ${compact(method)}.`);
  }
}

/** One line of stdio: parse it, answer it, hand back the line to write — or nothing. */
export async function handleLine(line: string, host: Host): Promise<string | undefined> {
  if (line.trim() === "") return undefined;
  let message: Json;
  try {
    message = JSON.parse(line) as Json;
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return compact(fault(null, PARSE_ERROR, `Could not parse the message: ${why}`));
  }
  const answer = await handle(message, host);
  return answer === undefined ? undefined : compact(answer);
}
