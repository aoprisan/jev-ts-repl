/** Turn the current session into a program written against a TypeSafe client. */

import type { Json } from "../json.js";
import { compact, isObject } from "../json.js";
import { questionToJson } from "../typesafe/questions.js";
import type { Session } from "./session.js";

const PACKAGE = "jev-repl";

interface Shaped {
  name: string;
  json: Json;
  kind: string;
}

function shape(session: Session): Shaped[] {
  return session.questions.map(([name, question]) => {
    const json = questionToJson(question);
    const kind = isObject(json) && typeof json["type"] === "string" ? json["type"] : "raw";
    return { name, json, kind };
  });
}

/** A JSON value as a TypeScript literal. */
function literal(v: Json | undefined): string {
  if (v === undefined) return "undefined";
  return typeof v === "string" ? JSON.stringify(v) : compact(v);
}

function criteriaOf(json: Json): Json | undefined {
  return isObject(json) ? json["criteria"] : undefined;
}

function instructionsOf(json: Json): Json | undefined {
  return isObject(json) ? json["instructions"] : undefined;
}

/** A valid bare property name, or a quoted one. */
function property(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** This session as a TypeScript program against the client this package ships. */
export function typescript(session: Session, model: string, threshold: number): string {
  const questions = shape(session);
  const used = new Set<string>(["Client"]);

  const lines: string[] = [];
  lines.push(`const client = Client.fromEnv(); // ${"TYPESAFE_API_KEY"}`);
  lines.push("");
  lines.push("const res = await client.systemOne(");
  lines.push(`  ${literal(session.state)},`);
  lines.push("  {");
  for (const q of questions) {
    used.add(q.kind === "raw" ? "raw" : q.kind);
    lines.push(`    ${property(q.name)}: ${builder(q, 4)},`);
  }
  lines.push("  },");
  lines.push(`  { model: ${JSON.stringify(model)} },`);
  lines.push(");");
  lines.push("");

  if (questions.length === 0) {
    lines.push("// add questions in the REPL and run :ts again");
  }
  for (const q of questions) lines.push(...reader(q, threshold));

  const imports = [...used].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");
  return `// npm i ${PACKAGE}\nimport { ${imports} } from ${JSON.stringify(PACKAGE)};\n\n${lines.join("\n")}\n`;
}

function builder(q: Shaped, indent: number): string {
  const pad = " ".repeat(indent + 2);
  const close = " ".repeat(indent);
  const instructions = literal(instructionsOf(q.json));
  const criteria = criteriaOf(q.json);
  switch (q.kind) {
    case "noul": {
      const parts: string[] = [];
      if (isObject(criteria)) {
        if (criteria["true"] !== undefined) parts.push(`yes: ${literal(criteria["true"])}`);
        if (criteria["false"] !== undefined) parts.push(`no: ${literal(criteria["false"])}`);
      }
      return parts.length === 0
        ? `noul(${instructions})`
        : `noul(${instructions}, {\n${pad}${parts.join(`,\n${pad}`)},\n${close}})`;
    }
    case "choice": {
      const rows = isObject(criteria)
        ? Object.entries(criteria).map(([label, desc]) => `${property(label)}: ${literal(desc)}`)
        : [];
      return rows.length === 0
        ? `choice(${instructions}, {})`
        : `choice(${instructions}, {\n${pad}${rows.join(`,\n${pad}`)},\n${close}})`;
    }
    case "score": {
      const levels = Array.isArray(criteria) ? criteria.map((l) => literal(l)) : [];
      const oneLine = `score(${instructions}, [${levels.join(", ")}])`;
      if (oneLine.length + indent <= 96) return oneLine;
      return `score(${instructions}, [\n${pad}${levels.join(`,\n${pad}`)},\n${close}])`;
    }
    default:
      return `raw(${compact(q.json)})`;
  }
}

function reader(q: Shaped, threshold: number): string[] {
  const name = q.name;
  const variable = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `answer_${hashName(name)}`;
  const lookup = JSON.stringify(name);
  switch (q.kind) {
    case "noul":
      return [
        `const ${variable} = res.noul(${lookup});`,
        `if (${variable}) {`,
        "  console.log(",
        `    \`${name}: \${${variable}.noul.toFixed(2)} -> \${${variable}.noul >= ${threshold.toFixed(2)}}\`,`,
        "  );",
        "}",
      ];
    case "choice":
      return [
        `const ${variable} = res.choice(${lookup});`,
        `if (${variable} && ${variable}.confidence >= 0.6) {`,
        `  console.log(\`${name}: \${${variable}.choice}\`);`,
        `} else if (${variable}) {`,
        `  console.log(\`${name}: unsure (\${${variable}.confidence.toFixed(2)}), send to a human\`);`,
        "}",
      ];
    case "score":
      return [
        `const ${variable} = res.score(${lookup});`,
        `if (${variable}) {`,
        "  console.log(",
        `    \`${name}: \${${variable}.score.toFixed(2)} of \${${variable}.legend.size - 1} \` +`,
        `      \`(confidence \${${variable}.confidence.toFixed(2)})\`,`,
        "  );",
        "}",
      ];
    default:
      return [`// ${name}: a raw question — read it from res.raw`];
  }
}

function hashName(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 0xffff;
  return h.toString(16);
}

/** This session as a Rust program against the `typesafe-ai-sdk` crate. */
export function rust(session: Session, model: string, threshold: number): string {
  const questions = shape(session);
  let out = "";
  out += "#[tokio::main]\nasync fn main() -> typesafe::Result<()> {\n";
  out += "    let client = Client::from_env()?; // TYPESAFE_API_KEY\n\n";
  out += "    let res = client\n        .system_one(\n";
  out += `            ${rustLiteral(session.state)},\n`;
  out += "            Questions::new()\n";
  for (const q of questions) {
    out += `                .with(${JSON.stringify(q.name)}, ${rustBuilder(q, 20)})\n`;
  }
  out += "        )\n";
  out += `        .model(${JSON.stringify(model)})\n`;
  out += "        .await?;\n\n";

  if (questions.length === 0) {
    out += "    // add questions in the REPL and run :rust again\n";
  }
  for (const q of questions) out += rustReader(q, threshold);
  out += "\n    Ok(())\n}\n";

  const imports = new Set(["Client", "Questions"]);
  for (const q of questions) {
    if (q.kind === "noul") imports.add("Noul");
    else if (q.kind === "choice") imports.add("Choice");
    else if (q.kind === "score") imports.add("Score");
  }
  if (out.includes("json!(")) imports.add("json");
  const list = [...imports].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(", ");
  return `// Cargo.toml: typesafe-ai-sdk = "0.1"\nuse typesafe::{${list}};\n\n${out}`;
}

function rustLiteral(v: Json | undefined): string {
  if (v === undefined) return "json!(null)";
  return typeof v === "string" ? JSON.stringify(v) : `json!(${compact(v)})`;
}

function rustBuilder(q: Shaped, indent: number): string {
  const pad = " ".repeat(indent + 4);
  const instructions =
    instructionsOf(q.json) === undefined ? "" : rustLiteral(instructionsOf(q.json));
  const criteria = criteriaOf(q.json);
  switch (q.kind) {
    case "noul": {
      let s = `Noul::new(${instructions})`;
      if (isObject(criteria)) {
        if (criteria["true"] !== undefined) {
          s += `\n${pad}.when_true(${rustLiteral(criteria["true"])})`;
        }
        if (criteria["false"] !== undefined) {
          s += `\n${pad}.when_false(${rustLiteral(criteria["false"])})`;
        }
      }
      return s;
    }
    case "choice": {
      let s = `Choice::new(${instructions})`;
      if (isObject(criteria)) {
        for (const [label, desc] of Object.entries(criteria)) {
          s +=
            desc === null
              ? `\n${pad}.label(${JSON.stringify(label)})`
              : `\n${pad}.option(${JSON.stringify(label)}, ${rustLiteral(desc)})`;
        }
      }
      return s;
    }
    case "score": {
      const levels = Array.isArray(criteria) ? criteria.map((l) => rustLiteral(l)) : [];
      return `Score::new(\n${pad}${instructions},\n${pad}[${levels.join(", ")}],\n${" ".repeat(indent)})`;
    }
    default:
      return `json!(${compact(q.json)})`;
  }
}

function rustReader(q: Shaped, threshold: number): string {
  const name = q.name;
  const lookup = JSON.stringify(name);
  switch (q.kind) {
    case "noul":
      return (
        `    let ${name} = res.noul(${lookup}).expect("asked");\n` +
        `    println!("${name}: {:.2} → {}", ${name}.noul, ${name}.is_yes(${threshold.toFixed(2)}));\n`
      );
    case "choice":
      return (
        `    let ${name} = res.choice(${lookup}).expect("asked");\n` +
        `    if ${name}.confidence >= 0.6 {\n` +
        `        println!("${name}: {}", ${name}.choice);\n` +
        `    } else {\n` +
        `        println!("${name}: unsure ({:.2}), send to a human", ${name}.confidence);\n` +
        `    }\n`
      );
    case "score":
      return (
        `    let ${name} = res.score(${lookup}).expect("asked");\n` +
        `    println!("${name}: {:.2} of {} (confidence {:.2})", ${name}.score, ${name}.legend.len() - 1, ${name}.confidence);\n`
      );
    default:
      return `    // ${name}: a raw question — read it from res.raw\n`;
  }
}
