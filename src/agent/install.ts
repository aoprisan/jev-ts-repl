/**
 * Where the jev MCP server and the jev skill go, for each agent that can host them.
 *
 * Every agent keeps its own file in its own shape, but the job is always the same: put one entry
 * in a config file without disturbing what is already there, and drop one `SKILL.md` in a
 * directory. This module is the pure half — paths and merged text, no filesystem — so the table
 * can be read in a test, and `jev install` stays a thin wrapper over it.
 *
 * ```ts
 * const target = targets(["claude-code"], ["mcp"], "project")[0];
 * const merged = merge(target, existingText, { name: "jev", command: "jev", args: ["mcp"], env: {} });
 * ```
 */

import type { Json, JsonObject } from "../json.js";
import { isObject, pretty, tryParse } from "../json.js";
import type { Parsed } from "../repl/session.js";
import { SKILL_FILE, SKILL_MD, SKILL_NAME } from "./skill.js";

/** An agent that can host the server, the skill, or both. */
export type ClientId = "claude-code" | "codex" | "opencode" | "pi";

/** Installed for this user, or into the repository in front of you. */
export type Scope = "user" | "project";

/** What is being installed. */
export type Kind = "mcp" | "skill";

/** How a client writes down an MCP server. */
export type Format = "mcp-json" | "codex-toml" | "opencode-json";

/** One agent: what to call it, where its files live, and what shape they are in. */
export interface ClientSpec {
  readonly id: ClientId;
  /** The name a person would recognise. */
  readonly title: string;
  readonly format: Format;
  /** The config file the MCP entry goes in, relative to the home directory or the project root. */
  readonly mcp: { readonly user: readonly string[]; readonly project: readonly string[] };
  /** The directory skills live in, which the skill's own folder goes inside. */
  readonly skill: { readonly user: readonly string[]; readonly project: readonly string[] };
  /** Paths under the home directory that mean this agent is installed. */
  readonly markers: ReadonlyArray<readonly string[]>;
  /** Anything a person needs to know after the file is written. */
  readonly note?: string;
}

/**
 * The four agents, and where each keeps its things.
 *
 * Claude Code and Codex read the config formats their own docs describe. OpenCode keeps MCP
 * servers under `mcp` with the command as a list. pi has no MCP client of its own — the entry is
 * written in the shape its MCP extensions read, which is Claude's.
 */
export const CLIENTS: readonly ClientSpec[] = [
  {
    id: "claude-code",
    title: "Claude Code",
    format: "mcp-json",
    mcp: { user: [".claude.json"], project: [".mcp.json"] },
    skill: { user: [".claude", "skills"], project: [".claude", "skills"] },
    markers: [[".claude"], [".claude.json"]],
  },
  {
    id: "codex",
    title: "Codex CLI",
    format: "codex-toml",
    mcp: { user: [".codex", "config.toml"], project: [".codex", "config.toml"] },
    skill: { user: [".codex", "skills"], project: [".codex", "skills"] },
    markers: [[".codex"]],
  },
  {
    id: "opencode",
    title: "OpenCode",
    format: "opencode-json",
    mcp: { user: [".config", "opencode", "opencode.json"], project: ["opencode.json"] },
    skill: { user: [".config", "opencode", "skills"], project: [".opencode", "skills"] },
    markers: [[".config", "opencode"]],
  },
  {
    id: "pi",
    title: "pi",
    format: "mcp-json",
    mcp: { user: [".pi", "agent", "mcp.json"], project: [".mcp.json"] },
    skill: { user: [".pi", "agent", "skills"], project: [".pi", "skills"] },
    markers: [[".pi"]],
    note: "pi has no MCP client built in: install an MCP extension (for example pi-mcp-adapter) to read this entry. The skill works as it is.",
  },
];

/** The client with this id, if it is one we know. */
export function findClient(id: string): ClientSpec | undefined {
  return CLIENTS.find((c) => c.id === id);
}

/** Every client id, for the help text and for `--client all`. */
export const CLIENT_IDS: readonly ClientId[] = CLIENTS.map((c) => c.id);

/** The server as a client writes it down. */
export interface Server {
  /** The key it is filed under; also what an agent prefixes its tools with. */
  readonly name: string;
  /** The program to run. */
  readonly command: string;
  readonly args: readonly string[];
  /** Environment for the server process, over what it inherits. */
  readonly env: Readonly<Record<string, string>>;
}

/** One file to write: which client it belongs to, what it is, and where it goes. */
export interface Target {
  readonly client: ClientSpec;
  readonly kind: Kind;
  readonly scope: Scope;
  /** Path segments below the home directory (user scope) or the project root (project scope). */
  readonly segments: readonly string[];
}

/** The file one kind of install writes for one client at one scope. */
export function file(client: ClientSpec, kind: Kind, scope: Scope): readonly string[] {
  if (kind === "mcp") return client.mcp[scope];
  return [...client.skill[scope], SKILL_NAME, SKILL_FILE];
}

/** Every file a run of `jev install` would touch, in a stable order. */
export function targets(
  clients: readonly ClientId[],
  kinds: readonly Kind[],
  scope: Scope,
): Target[] {
  const out: Target[] = [];
  for (const id of clients) {
    const client = findClient(id);
    if (client === undefined) continue;
    for (const kind of kinds)
      out.push({ client, kind, scope, segments: file(client, kind, scope) });
  }
  return out;
}

/** The MCP entry, in the shape this client reads. */
export function entry(format: Format, server: Server): Json {
  const env: JsonObject = {};
  for (const [name, value] of Object.entries(server.env)) env[name] = value;
  const hasEnv = Object.keys(env).length > 0;
  if (format === "opencode-json") {
    const value: JsonObject = {
      type: "local",
      command: [server.command, ...server.args],
      enabled: true,
    };
    if (hasEnv) value["environment"] = env;
    return value;
  }
  const value: JsonObject = { type: "stdio", command: server.command, args: [...server.args] };
  if (hasEnv) value["env"] = env;
  return value;
}

/** The key an MCP server is filed under in this client's config. */
function section(format: Format): string {
  return format === "opencode-json" ? "mcp" : "mcpServers";
}

/**
 * The config file with the entry in it, keeping everything else exactly as it was.
 *
 * An empty or missing file becomes a fresh one; a file that is not JSON is left alone and reported,
 * because a hand-edited config is not something to guess at.
 */
function mergeJson(format: Format, existing: string, server: Server): Parsed<string> {
  const trimmed = existing.trim();
  let root: JsonObject = {};
  if (trimmed !== "") {
    const parsed = tryParse(trimmed);
    if (!isObject(parsed)) {
      return { ok: false, error: "the file is not a JSON object; fix or move it and run again." };
    }
    root = { ...parsed };
  } else if (format === "opencode-json") {
    root["$schema"] = "https://opencode.ai/config.json";
  }
  const key = section(format);
  const servers = isObject(root[key]) ? { ...(root[key] as JsonObject) } : {};
  servers[server.name] = entry(format, server);
  root[key] = servers;
  return { ok: true, value: `${pretty(root)}\n` };
}

/** A TOML basic string: the two escapes a path or a key can actually need. */
function tomlString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A bare key where TOML allows one, quoted where it does not. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : tomlString(name);
}

/** The `[mcp_servers.<name>]` table Codex reads. */
export function tomlTable(server: Server): string {
  const lines = [
    `[mcp_servers.${tomlKey(server.name)}]`,
    `command = ${tomlString(server.command)}`,
    `args = [${server.args.map(tomlString).join(", ")}]`,
  ];
  const env = Object.entries(server.env);
  if (env.length > 0) {
    const pairs = env.map(([name, value]) => `${tomlKey(name)} = ${tomlString(value)}`);
    lines.push(`env = { ${pairs.join(", ")} }`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The same, for a file of TOML.
 *
 * There is no TOML parser here on purpose: a config file is someone's, and a round trip through a
 * parser would reflow their comments and reorder their tables. So the table is found as text and
 * replaced as text — from its header to the next table that is not one of its own subtables.
 */
function mergeToml(existing: string, server: Server): Parsed<string> {
  const table = tomlTable(server);
  const header = `[mcp_servers.${tomlKey(server.name)}]`;
  const lines = existing.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const body = existing.replace(/\s*$/, "");
    return { ok: true, value: body === "" ? table : `${body}\n\n${table}` };
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (!line.startsWith("[")) continue;
    if (line.startsWith(`[mcp_servers.${tomlKey(server.name)}.`)) continue;
    end = i;
    break;
  }
  const before = lines.slice(0, start).join("\n").replace(/\s*$/, "");
  const after = lines
    .slice(end)
    .join("\n")
    .replace(/^\s*\n/, "");
  const head = before === "" ? "" : `${before}\n\n`;
  const tail = after.trim() === "" ? "" : `\n${after.replace(/^\n+/, "")}`;
  return { ok: true, value: `${head}${table}${tail}` };
}

/** The skill file: the same markdown for every host, because SKILL.md is one format. */
export function skillText(): string {
  return SKILL_MD;
}

/**
 * What this target's file should contain once jev is installed, given what it contains now.
 *
 * `existing` is the current text, or `""` when there is no file yet.
 */
export function merge(target: Target, existing: string, server: Server): Parsed<string> {
  if (target.kind === "skill") return { ok: true, value: skillText() };
  if (target.client.format === "codex-toml") return mergeToml(existing, server);
  return mergeJson(target.client.format, existing, server);
}

/** One line describing a target, for `--dry-run` and for the summary. */
export function describe(target: Target, path: string): string {
  const what = target.kind === "mcp" ? "MCP server" : "skill";
  return `${target.client.title} ${what} (${target.scope}): ${path}`;
}

/**
 * Whether a `SKILL.md` already there is a copy of ours, possibly an older one.
 *
 * Installing over our own file is an upgrade; installing over a file someone wrote or edited is
 * not, so it takes `--force`. The frontmatter name is the only mark a skill file carries.
 */
export function looksLikeOurs(existing: string): boolean {
  if (existing.trim() === "") return true;
  if (!existing.startsWith("---")) return false;
  const end = existing.indexOf("\n---", 3);
  const frontmatter = end === -1 ? existing : existing.slice(0, end);
  return new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, "m").test(frontmatter);
}
