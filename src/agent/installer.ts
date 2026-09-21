/**
 * `jev install` — put the MCP server and the skill where an agent will find them.
 *
 * The decisions all live in `install.ts`; this is the part that reads the command line, finds the
 * home directory, and writes the files it is told to.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as install from "./install.js";
import type { ClientId, Kind, Scope, Server, Target } from "./install.js";

/** A command line that did not make sense. */
class UsageError extends Error {}

export const INSTALL_HELP = `jev install — register jev with a coding agent

  jev install                     the MCP server and the skill, for every agent found
  jev install mcp                 just the MCP server
  jev install skill               just the skill
  jev install --list              the agents, and where each one's files go

Options
  --client <id[,id]>     ${install.CLIENT_IDS.join(", ")}, or all
                         (default: every agent installed for this user)
  --scope user|project   this user (default) or the repository in front of you
  --name <name>          file the server under this name (default jev)
  --command <path>       the program the agent runs (default: this binary)
  --env NAME=VALUE       an environment variable for the server; repeatable
  --root <dir>           the project root for --scope project (default: this directory)
  --home <dir>           the home directory to install under (default: yours)
  --dry-run              say what would be written, write nothing
  --force                replace a SKILL.md that is not ours

Nothing else in a config file is touched: the entry is merged in, and a file that
cannot be parsed is reported rather than rewritten.
`;

/** What `jev install` was asked to do. */
interface Options {
  kinds: Kind[];
  clients: ClientId[] | undefined;
  scope: Scope;
  server: Server;
  root: string;
  home: string;
  dryRun: boolean;
  force: boolean;
  list: boolean;
}

/** The program an agent should run to start the server: this binary, as an absolute path. */
export function selfCommand(argv: readonly string[] = process.argv): {
  command: string;
  args: string[];
} {
  const entry = argv[1];
  if (entry === undefined) return { command: "jev", args: ["mcp"] };
  const script = resolve(entry);
  // An npm-installed `jev` is a shim that already knows how to find node; a checkout is not.
  return { command: process.execPath, args: [script, "mcp"] };
}

function parse(argv: readonly string[], env: NodeJS.ProcessEnv): Options {
  const self = selfCommand();
  const options: Options = {
    kinds: [],
    clients: undefined,
    scope: "user",
    server: { name: "jev", command: self.command, args: self.args, env: {} },
    root: process.cwd(),
    home: env["HOME"] ?? homedir(),
    dryRun: false,
    force: false,
    list: false,
  };
  let command: string | undefined;
  const extra: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const valueOf = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${name} needs a value.`);
      return next;
    };
    switch (name) {
      case "mcp":
      case "skill":
        options.kinds.push(name);
        break;
      case "all":
        options.kinds.push("mcp", "skill");
        break;
      case "--list":
        options.list = true;
        break;
      case "--client": {
        const ids = valueOf()
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== "");
        const chosen: ClientId[] = [];
        for (const id of ids) {
          if (id === "all") {
            chosen.push(...install.CLIENT_IDS);
            continue;
          }
          const client = install.findClient(id);
          if (client === undefined) {
            throw new UsageError(`unknown agent ${JSON.stringify(id)}; --list has them.`);
          }
          chosen.push(client.id);
        }
        options.clients = [...new Set([...(options.clients ?? []), ...chosen])];
        break;
      }
      case "--scope": {
        const scope = valueOf();
        if (scope !== "user" && scope !== "project") {
          throw new UsageError("--scope takes user or project.");
        }
        options.scope = scope;
        break;
      }
      case "--name":
        options.server = { ...options.server, name: valueOf() };
        break;
      case "--command":
        command = valueOf();
        break;
      case "--env": {
        const pair = valueOf();
        const at = pair.indexOf("=");
        if (at <= 0) throw new UsageError("--env takes NAME=VALUE.");
        extra[pair.slice(0, at)] = pair.slice(at + 1);
        break;
      }
      case "--root":
        options.root = resolve(valueOf());
        break;
      case "--home":
        options.home = resolve(valueOf());
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
      case "-h":
        options.list = true;
        break;
      default:
        throw new UsageError(`unknown option ${JSON.stringify(arg)}; jev install --help.`);
    }
  }

  if (command !== undefined) {
    // A command given by hand replaces the whole invocation, not just the program.
    options.server = { ...options.server, command, args: ["mcp"] };
  }
  options.server = { ...options.server, env: extra };
  if (options.kinds.length === 0) options.kinds = ["mcp", "skill"];
  options.kinds = [...new Set(options.kinds)];
  return options;
}

/** The agents this user has, judged by whether their directories exist. */
export function detect(home: string): ClientId[] {
  return install.CLIENTS.filter((client) =>
    client.markers.some((marker) => existsSync(join(home, ...marker))),
  ).map((client) => client.id);
}

/** Where a target's file lands on this machine. */
function pathOf(target: Target, options: Options): string {
  return join(target.scope === "user" ? options.home : options.root, ...target.segments);
}

/** The agents and their paths, for `--list`. */
function list(options: Options, out: (text: string) => void): number {
  const found = new Set(detect(options.home));
  for (const client of install.CLIENTS) {
    out(`${client.title} (${client.id})${found.has(client.id) ? " — installed" : ""}\n`);
    for (const scope of ["user", "project"] as const) {
      for (const kind of ["mcp", "skill"] as const) {
        const segments = install.file(client, kind, scope);
        const base = scope === "user" ? "~" : ".";
        out(`  ${kind.padEnd(5)} ${scope.padEnd(7)} ${[base, ...segments].join("/")}\n`);
      }
    }
    if (client.note !== undefined) out(`  note: ${client.note}\n`);
    out("\n");
  }
  return 0;
}

/** Install, or say what installing would do. */
export function runInstall(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  out: (text: string) => void,
  err: (text: string) => void,
): number {
  let options: Options;
  try {
    options = parse(argv, env);
  } catch (e) {
    err(`jev install: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  if (options.list) {
    out(INSTALL_HELP);
    out("\n");
    return list(options, out);
  }

  let clients = options.clients;
  if (clients === undefined) {
    clients = detect(options.home);
    if (clients.length === 0) {
      err(
        "jev install: no agent found under this home directory.\n" +
          `Pass --client <${install.CLIENT_IDS.join("|")}>, or --client all; jev install --list has them.\n`,
      );
      return 1;
    }
  }

  const notes = new Set<string>();
  let failed = false;
  let wrote = 0;
  for (const target of install.targets(clients, options.kinds, options.scope)) {
    const path = pathOf(target, options);
    const where = install.describe(target, path);
    let existing = "";
    if (existsSync(path)) {
      try {
        existing = readFileSync(path, "utf8");
      } catch (e) {
        err(`jev install: could not read ${path}: ${e instanceof Error ? e.message : e}\n`);
        failed = true;
        continue;
      }
    }
    if (target.kind === "skill" && !options.force && !install.looksLikeOurs(existing)) {
      err(`jev install: ${path} was not written by jev; pass --force to replace it.\n`);
      failed = true;
      continue;
    }

    const merged = install.merge(target, existing, options.server);
    if (!merged.ok) {
      err(`jev install: ${path}: ${merged.error}\n`);
      failed = true;
      continue;
    }
    if (merged.value === existing) {
      out(`${where} — already there\n`);
      continue;
    }
    const verb = existing === "" ? "created" : "updated";
    if (options.dryRun) {
      out(`${where} — would be ${verb}\n`);
      continue;
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, merged.value);
    } catch (e) {
      err(`jev install: could not write ${path}: ${e instanceof Error ? e.message : e}\n`);
      failed = true;
      continue;
    }
    out(`${where} — ${verb}\n`);
    wrote++;
    if (target.client.note !== undefined) notes.add(target.client.note);
  }

  for (const note of notes) out(`\nnote: ${note}\n`);
  if (wrote > 0 && options.kinds.includes("mcp")) {
    out(
      "\nThe server is started by the agent, so it inherits that agent's environment:\n" +
        "set TYPESAFE_API_KEY there, or pass --env TYPESAFE_API_KEY=… to write it into the config.\n" +
        "Restart the agent to pick up the new server.\n",
    );
  }
  return failed ? 1 : 0;
}
