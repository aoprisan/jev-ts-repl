/**
 * The agent side: the MCP protocol, where an install puts its files, and the skill the two ship.
 *
 * The protocol half is pure, so it is driven here as messages in and messages out — no pipe, no
 * child process — and the CLI tests at the bottom check that the same handler is on the binary.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import * as install from "../src/agent/install.js";
import type { Host, Result, Sent } from "../src/agent/mcp.js";
import * as mcp from "../src/agent/mcp.js";
import { SKILL_MD, SKILL_NAME } from "../src/agent/skill.js";
import type { Json, JsonObject } from "../src/json.js";
import { isObject } from "../src/json.js";
import * as headless from "../src/repl/headless.js";
import type { Session } from "../src/repl/session.js";

const CLI = resolve(import.meta.dirname, "../dist/cli.js");
const built = existsSync(CLI);

const PAGE = `A payout failed again, third time this month.
---
is_urgent? The message conveys urgency
department: Which team should handle this
  billing = Payment or subscription issues
  technical = Bugs or integration problems
`;

/** A host that answers offline, the way `jev mcp` does without a key. */
function offline(overrides: Partial<Host> = {}): Host {
  return {
    version: "9.9.9",
    model: "jev-test",
    live: false,
    ask: (session: Session) =>
      Promise.resolve({ ok: true, answers: headless.mockAnswers(session) } as Sent),
    ...overrides,
  };
}

async function request(method: string, params?: JsonObject, host: Host = offline()): Promise<Json> {
  const message: JsonObject = { jsonrpc: "2.0", id: 1, method };
  if (params !== undefined) message["params"] = params;
  const answer = await mcp.handle(message, host);
  if (answer === undefined) throw new Error(`${method} answered nothing`);
  return answer;
}

/** The `result` of a reply, or a failure naming what came back instead. */
function resultOf(reply: Json): JsonObject {
  if (!isObject(reply) || !isObject(reply["result"])) {
    throw new Error(`expected a result, got ${JSON.stringify(reply)}`);
  }
  return reply["result"];
}

/** The text a tool call printed, and whether it was an error. */
function toolText(reply: Json): { text: string; isError: boolean } {
  const result = resultOf(reply) as unknown as Result;
  return {
    text: result.content.map((block) => block.text).join(""),
    isError: result.isError === true,
  };
}

const callTool = async (name: string, args: JsonObject, host: Host = offline()) =>
  toolText(await request("tools/call", { name, arguments: args }, host));

describe("the MCP handshake", () => {
  it("answers initialize with the protocol the client asked for", async () => {
    const result = resultOf(
      await request("initialize", { protocolVersion: "2024-11-05", capabilities: {} }),
    );
    expect(result["protocolVersion"]).toBe("2024-11-05");
    expect(result["capabilities"]).toEqual({ tools: { listChanged: false } });
    expect(result["serverInfo"]).toMatchObject({ name: "jev", version: "9.9.9" });
  });

  it("falls back to its own protocol when the client asks for one it does not know", async () => {
    const result = resultOf(await request("initialize", { protocolVersion: "1999-01-01" }));
    expect(result["protocolVersion"]).toBe(mcp.PROTOCOL_VERSION);
  });

  it("says in the instructions when every answer will be simulated", async () => {
    const offlineResult = resultOf(await request("initialize", {}));
    expect(String(offlineResult["instructions"])).toContain("no API key");
    const liveResult = resultOf(await request("initialize", {}, offline({ live: true })));
    expect(String(liveResult["instructions"])).not.toContain("no API key");
  });

  it("answers a notification with nothing at all", async () => {
    const answer = await mcp.handle(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      offline(),
    );
    expect(answer).toBeUndefined();
  });

  it("answers ping, so a client can tell the server is still there", async () => {
    expect(resultOf(await request("ping"))).toEqual({});
  });

  it("refuses a method it does not have", async () => {
    const reply = await request("sampling/createMessage");
    expect(isObject(reply) && (reply["error"] as JsonObject)["code"]).toBe(mcp.METHOD_NOT_FOUND);
  });

  it("reports a line that is not JSON as a parse error, and keeps going", async () => {
    const line = await mcp.handleLine("{not json", offline());
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toMatchObject({ error: { code: mcp.PARSE_ERROR } });
    expect(await mcp.handleLine("   ", offline())).toBeUndefined();
  });
});

describe("the tools", () => {
  it("lists every tool with a schema a client can validate against", async () => {
    const result = resultOf(await request("tools/list"));
    const tools = result["tools"] as unknown as typeof mcp.TOOLS;
    expect(tools.map((t) => t.name)).toEqual([
      "jev_notation",
      "jev_check",
      "jev_request",
      "jev_cost",
      "jev_ask",
      "jev_eval",
      "jev_code",
      "jev_presets",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema["type"]).toBe("object");
    }
  });

  it("hands over the notation, which is the skill itself", async () => {
    const { text } = await callTool("jev_notation", {});
    expect(text).toBe(SKILL_MD);
  });

  it("checks a page and says what it parsed into", async () => {
    const { text, isError } = await callTool("jev_check", { page: PAGE });
    expect(isError).toBe(false);
    expect(text).toContain("is_urgent (noul)");
    expect(text).toContain("department (choice)");
  });

  it("reports a broken page as an error result, with the line number", async () => {
    const { text, isError } = await callTool("jev_check", { page: "state\n---\nbroken? \n" });
    expect(isError).toBe(true);
    expect(text).toContain("line 3");
  });

  it("prints the request body the page would POST", async () => {
    const { text } = await callTool("jev_request", { page: PAGE, model: "jev-2" });
    const body = JSON.parse(text) as JsonObject;
    expect(body["model"]).toBe("jev-2");
    expect(Object.keys(body["questions"] as JsonObject)).toEqual(["is_urgent", "department"]);
  });

  it("takes the model off the page when the call does not name one", async () => {
    const pinned = PAGE.replace("---\n", "---\n@model pinned\n");
    const { text } = await callTool("jev_request", { page: pinned });
    expect((JSON.parse(text) as JsonObject)["model"]).toBe("pinned");
  });

  it("prices a page when it is given rates", async () => {
    const { text } = await callTool("jev_cost", { page: PAGE, price: "0.20/1.00" });
    expect(text).toMatch(/\$/);
  });

  it("says what is wrong with the rates rather than pricing nothing", async () => {
    const { text, isError } = await callTool("jev_cost", { page: PAGE, price: "free" });
    expect(isError).toBe(true);
    expect(text).toContain("jev_cost");
  });

  it("answers offline, and says the answers are simulated", async () => {
    const { text, isError } = await callTool("jev_ask", { page: PAGE });
    expect(isError).toBe(false);
    expect(text).toContain("is_urgent");
    expect(text).toContain("Simulated answers");
  });

  it("does not stamp a live answer as simulated", async () => {
    const { text } = await callTool("jev_ask", { page: PAGE }, offline({ live: true }));
    expect(text).not.toContain("Simulated answers");
  });

  it("refuses to send a page with no state", async () => {
    const { text, isError } = await callTool("jev_ask", { page: "---\nis_urgent? Urgent" });
    expect(isError).toBe(true);
    expect(text).toContain("No state");
  });

  it("judges the state the call passes, not the one on the page", async () => {
    const seen: string[] = [];
    const host = offline({
      ask: (session: Session) => {
        seen.push(String(session.state));
        return Promise.resolve({ ok: true, answers: headless.mockAnswers(session) } as Sent);
      },
    });
    await callTool("jev_ask", { page: PAGE, state: "Something else entirely" }, host);
    expect(seen).toEqual(["Something else entirely"]);
  });

  it("passes a failed call back as an error result", async () => {
    const host = offline({
      ask: () => Promise.resolve({ ok: false, error: "401 no key" } as Sent),
    });
    const { text, isError } = await callTool("jev_ask", { page: PAGE }, host);
    expect(isError).toBe(true);
    expect(text).toContain("401 no key");
  });

  it("scores a page over labelled cases", async () => {
    const cases = [
      '{"state": "My card was declined", "expect": {"department": "billing"}}',
      '{"state": "The webhook returns 500", "expect": {"department": "technical"}}',
    ].join("\n");
    const { text, isError } = await callTool("jev_eval", { page: PAGE, cases, json: true });
    expect(isError).toBe(false);
    const report = JSON.parse(text) as JsonObject;
    expect(report["cases"]).toBe(2);
    expect(report["errors"]).toEqual([]);
  });

  it("says which line of the cases file it could not read", async () => {
    const { text, isError } = await callTool("jev_eval", { page: PAGE, cases: "{oops}" });
    expect(isError).toBe(true);
    expect(text).toContain("jev_eval");
  });

  it("writes the page out as a program in either language", async () => {
    const ts = await callTool("jev_code", { page: PAGE, language: "ts" });
    expect(ts.text).toContain("systemOne");
    const rust = await callTool("jev_code", { page: PAGE, language: "rust" });
    expect(rust.text).toContain("fn main");
    const wrong = await callTool("jev_code", { page: PAGE, language: "python" });
    expect(wrong.isError).toBe(true);
  });

  it("hands over ready-made pages that parse", async () => {
    const all = await callTool("jev_presets", {});
    expect(all.text).toContain("# triage");
    const one = await callTool("jev_presets", { name: "moderation" });
    const page = one.text.slice(one.text.indexOf("\n\n") + 2);
    expect(headless.load(page).ok).toBe(true);
    const missing = await callTool("jev_presets", { name: "nope" });
    expect(missing.isError).toBe(true);
  });

  it("names a tool it does not have instead of throwing", async () => {
    const { text, isError } = await callTool("jev_teleport", {});
    expect(isError).toBe(true);
    expect(text).toContain("tools/list");
  });

  it("rejects an argument of the wrong type", async () => {
    const { text, isError } = await callTool("jev_check", { page: 12 as unknown as Json });
    expect(isError).toBe(true);
    expect(text).toContain("must be a string");
  });
});

describe("where an install puts things", () => {
  const server: install.Server = {
    name: "jev",
    command: "/opt/jev",
    args: ["mcp"],
    env: { TYPESAFE_API_KEY: "sk-test" },
  };

  it("knows the four agents and both scopes", () => {
    expect(install.CLIENT_IDS).toEqual(["claude-code", "codex", "opencode", "pi"]);
    const paths = (scope: install.Scope) =>
      install.CLIENT_IDS.map((id) =>
        install.file(install.findClient(id) as install.ClientSpec, "mcp", scope).join("/"),
      );
    expect(paths("user")).toEqual([
      ".claude.json",
      ".codex/config.toml",
      ".config/opencode/opencode.json",
      ".pi/agent/mcp.json",
    ]);
    expect(paths("project")).toEqual([
      ".mcp.json",
      ".codex/config.toml",
      "opencode.json",
      ".mcp.json",
    ]);
  });

  it("puts the skill in a folder of its own, under every agent's skills directory", () => {
    for (const id of install.CLIENT_IDS) {
      const client = install.findClient(id) as install.ClientSpec;
      for (const scope of ["user", "project"] as const) {
        const segments = install.file(client, "skill", scope);
        expect(segments.slice(-2)).toEqual([SKILL_NAME, "SKILL.md"]);
      }
    }
  });

  it("merges into a config that already has servers in it", () => {
    const target = install.targets(["claude-code"], ["mcp"], "project")[0] as install.Target;
    const existing = '{"numStartups": 5, "mcpServers": {"other": {"command": "y"}}}';
    const merged = install.merge(target, existing, server);
    expect(merged.ok).toBe(true);
    const root = JSON.parse((merged as { value: string }).value) as JsonObject;
    expect(root["numStartups"]).toBe(5);
    const servers = root["mcpServers"] as JsonObject;
    expect(Object.keys(servers)).toEqual(["other", "jev"]);
    expect(servers["jev"]).toEqual({
      type: "stdio",
      command: "/opt/jev",
      args: ["mcp"],
      env: { TYPESAFE_API_KEY: "sk-test" },
    });
  });

  it("writes OpenCode's shape, with the command as a list", () => {
    const target = install.targets(["opencode"], ["mcp"], "user")[0] as install.Target;
    const merged = install.merge(target, "", server) as { ok: true; value: string };
    const root = JSON.parse(merged.value) as JsonObject;
    expect(root["$schema"]).toBe("https://opencode.ai/config.json");
    expect((root["mcp"] as JsonObject)["jev"]).toEqual({
      type: "local",
      command: ["/opt/jev", "mcp"],
      enabled: true,
      environment: { TYPESAFE_API_KEY: "sk-test" },
    });
  });

  it("leaves a JSON config alone when it cannot be read", () => {
    const target = install.targets(["pi"], ["mcp"], "user")[0] as install.Target;
    expect(install.merge(target, "[1, 2]", server).ok).toBe(false);
    expect(install.merge(target, "{oops", server).ok).toBe(false);
  });

  it("appends a TOML table without touching the rest of the file", () => {
    const target = install.targets(["codex"], ["mcp"], "user")[0] as install.Target;
    const existing = '# mine\n[history]\npersistence = "save-all"\n';
    const merged = install.merge(target, existing, server) as { ok: true; value: string };
    expect(merged.value).toContain("# mine");
    expect(merged.value).toContain('persistence = "save-all"');
    expect(merged.value).toContain('[mcp_servers.jev]\ncommand = "/opt/jev"\nargs = ["mcp"]');
    expect(merged.value).toContain('env = { TYPESAFE_API_KEY = "sk-test" }');
  });

  it("replaces the table it wrote before, and only that one", () => {
    const target = install.targets(["codex"], ["mcp"], "user")[0] as install.Target;
    const existing =
      '[mcp_servers.other]\ncommand = "x"\n\n' +
      '[mcp_servers.jev]\ncommand = "/old/jev"\nargs = ["mcp"]\n\n' +
      '[mcp_servers.jev.env]\nTYPESAFE_API_KEY = "old"\n\n' +
      '[tui]\ntheme = "dark"\n';
    const merged = install.merge(target, existing, server) as { ok: true; value: string };
    expect(merged.value).not.toContain("/old/jev");
    expect(merged.value).not.toContain('TYPESAFE_API_KEY = "old"');
    expect(merged.value).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(merged.value).toContain('[tui]\ntheme = "dark"');
    expect(merged.value.match(/\[mcp_servers\.jev\]/g)).toHaveLength(1);
  });

  it("quotes a path with a space or a backslash in it", () => {
    const windows: install.Server = {
      name: "jev",
      command: 'C:\\Program Files\\jev\\"jev".exe',
      args: ["mcp"],
      env: {},
    };
    expect(install.tomlTable(windows)).toContain(
      'command = "C:\\\\Program Files\\\\jev\\\\\\"jev\\".exe"',
    );
  });

  it("installs the skill as-is, whatever the agent", () => {
    for (const id of install.CLIENT_IDS) {
      const target = install.targets([id], ["skill"], "user")[0] as install.Target;
      const merged = install.merge(target, "old text", server) as { ok: true; value: string };
      expect(merged.value).toBe(SKILL_MD);
    }
  });

  it("can tell its own skill file from someone else's", () => {
    expect(install.looksLikeOurs("")).toBe(true);
    expect(install.looksLikeOurs(SKILL_MD)).toBe(true);
    expect(install.looksLikeOurs("---\nname: jev\ndescription: an older one\n---\nhi")).toBe(true);
    expect(install.looksLikeOurs("---\nname: mine\n---\nhi")).toBe(false);
    expect(install.looksLikeOurs("# my notes")).toBe(false);
  });
});

describe("the skill", () => {
  it("is the file people read, byte for byte", () => {
    const onDisk = readFileSync(resolve(import.meta.dirname, "../skills/jev/SKILL.md"), "utf8");
    expect(SKILL_MD).toBe(onDisk);
  });

  it("starts with the frontmatter every host reads it by", () => {
    const end = SKILL_MD.indexOf("\n---", 3);
    const frontmatter = SKILL_MD.slice(0, end);
    expect(frontmatter.startsWith("---\n")).toBe(true);
    expect(frontmatter).toContain(`name: ${SKILL_NAME}`);
    expect(frontmatter).toContain("description:");
  });

  it("teaches the notation it claims to", () => {
    for (const mark of ["name? instructions", "label = description", "`<`", "@model"]) {
      expect(SKILL_MD).toContain(mark);
    }
  });
});

describe.runIf(built)("the binary", () => {
  const homes: string[] = [];
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "jev-install-"));
    homes.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of homes) rmSync(dir, { recursive: true, force: true });
  });

  const jev = (args: readonly string[], input = "") =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      input,
      env: { ...process.env, TYPESAFE_API_KEY: "", JEV_PRICE: "" },
    });

  it("lists every agent and where its files go", () => {
    const done = jev(["install", "--list"]);
    expect(done.status).toBe(0);
    for (const id of install.CLIENT_IDS) expect(done.stdout).toContain(id);
    expect(done.stdout).toContain("~/.codex/config.toml");
  });

  it("writes nothing for a dry run", () => {
    const home = temp();
    const done = jev(["install", "--home", home, "--client", "all", "--dry-run"]);
    expect(done.status).toBe(0);
    expect(done.stdout).toContain("would be created");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  it("installs for one agent and leaves the others alone", () => {
    const home = temp();
    const done = jev(["install", "--home", home, "--client", "codex", "--command", "jev"]);
    expect(done.status).toBe(0);
    const toml = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain('[mcp_servers.jev]\ncommand = "jev"');
    expect(readFileSync(join(home, ".codex", "skills", "jev", "SKILL.md"), "utf8")).toBe(SKILL_MD);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  it("refuses to overwrite a SKILL.md it did not write, until it is told to", () => {
    const home = temp();
    const path = join(home, ".claude", "skills", "jev", "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "---\nname: mine\n---\nhands off\n");
    const refused = jev(["install", "skill", "--home", home, "--client", "claude-code"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--force");
    expect(readFileSync(path, "utf8")).toContain("hands off");
    const forced = jev(["install", "skill", "--home", home, "--client", "claude-code", "--force"]);
    expect(forced.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(SKILL_MD);
  });

  it("says when it cannot find an agent to install into", () => {
    const done = jev(["install", "--home", temp()]);
    expect(done.status).toBe(1);
    expect(done.stderr).toContain("--client");
  });

  it("exits 2 on a command line it cannot parse", () => {
    expect(jev(["install", "--client", "emacs"]).status).toBe(2);
    expect(jev(["install", "--scope", "galaxy"]).status).toBe(2);
    expect(jev(["mcp", "page.jev"]).status).toBe(2);
  });

  it("serves the protocol on stdin and stdout", () => {
    const lines = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"jev_check","arguments":' +
        `{"page":${JSON.stringify(PAGE)}}}}`,
    ].join("\n");
    const done = jev(["mcp"], `${lines}\n`);
    expect(done.status).toBe(0);
    const replies = done.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as JsonObject);
    // Two messages carried an id, and the notification must not have been answered.
    expect(replies).toHaveLength(2);
    expect(resultOf(replies[0] as Json)["serverInfo"]).toMatchObject({ name: "jev" });
    expect(toolText(replies[1] as Json).text).toContain("is_urgent (noul)");
    expect(done.stderr).toContain("simulated");
  });
});
