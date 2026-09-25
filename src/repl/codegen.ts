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
  /** The page's `@threshold` or `@confidence` for this question, when it wrote one down. */
  bar: number | undefined;
}

function shape(session: Session): Shaped[] {
  return session.questions.map(([name, question]) => {
    const json = questionToJson(question);
    const kind = isObject(json) && typeof json["type"] === "string" ? json["type"] : "raw";
    return { name, json, kind, bar: session.bar(name) };
  });
}

/** What a choice is gated at when the page names no bar: the README's rule of thumb. */
const CHOICE_GATE = 0.6;

/**
 * A threshold as code: two decimals, the way it has always been printed, unless that would change
 * it — a bar someone wrote as `0.625` is `0.625` in the program too.
 */
function thresholdLiteral(t: number): string {
  const fixed = t.toFixed(2);
  return Number(fixed) === t ? fixed : String(t);
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

/**
 * This session as a TypeScript program against the client this package ships. The questions go
 * into a `rubric`, so every answer the program reads is typed by its question and a choice's label
 * is one of its own.
 */
export function typescript(session: Session, model: string, threshold: number): string {
  const questions = shape(session);
  const used = new Set<string>(["Client", "rubric"]);

  const lines: string[] = [];
  lines.push(`const client = Client.fromEnv(); // ${"TYPESAFE_API_KEY"}`);
  lines.push("");
  lines.push("const questions = rubric({");
  for (const q of questions) {
    used.add(q.kind === "raw" ? "raw" : q.kind);
    lines.push(`  ${property(q.name)}: ${builder(q, 2)},`);
  }
  lines.push("});");
  lines.push("");
  lines.push("const { answers } = await client.ask(");
  lines.push(`  ${literal(session.state)},`);
  lines.push("  questions,");
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
  const cut = thresholdLiteral(q.bar ?? threshold);
  const variable = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `answer_${hashName(name)}`;
  const access = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `answers.${name}`
    : `answers[${JSON.stringify(name)}]`;
  const unsure = `  console.log(\`${name}: unsure (\${${variable}.confidence.toFixed(2)}), send to a human\`);`;
  const scoreLine = [
    "console.log(",
    `  \`${name}: \${${variable}.score.toFixed(2)} of \${${variable}.legend.size - 1} \` +`,
    `    \`(confidence \${${variable}.confidence.toFixed(2)})\`,`,
    ");",
  ];
  switch (q.kind) {
    case "noul":
      return [
        `const ${variable} = ${access};`,
        `console.log(\`${name}: \${${variable}.noul.toFixed(2)} -> \${${variable}.noul >= ${cut}}\`);`,
      ];
    case "choice":
      return [
        `const ${variable} = ${access};`,
        `if (${variable}.confidence >= ${String(q.bar ?? CHOICE_GATE)}) {`,
        `  console.log(\`${name}: \${${variable}.choice}\`);`,
        "} else {",
        unsure,
        "}",
      ];
    case "score":
      if (q.bar !== undefined) {
        // A score with a bar is gated like a choice: act above it, hand the rest to a person.
        return [
          `const ${variable} = ${access};`,
          `if (${variable}.confidence >= ${String(q.bar)}) {`,
          ...scoreLine.map((l) => `  ${l}`),
          "} else {",
          unsure,
          "}",
        ];
      }
      return [`const ${variable} = ${access};`, ...scoreLine];
    default:
      return [`// ${name}: a raw question — its answer is ${access}, typed as any Answer`];
  }
}

/** A float literal Rust reads as an `f64`: `0.7` stays `0.7`, but `1` has to be `1.0`. */
function rustFloat(n: number): string {
  const text = String(n);
  return /[.e]/.test(text) ? text : `${text}.0`;
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
  const cut = thresholdLiteral(q.bar ?? threshold);
  const lookup = JSON.stringify(name);
  switch (q.kind) {
    case "noul":
      return (
        `    let ${name} = res.noul(${lookup}).expect("asked");\n` +
        `    println!("${name}: {:.2} → {}", ${name}.noul, ${name}.is_yes(${cut}));\n`
      );
    case "choice":
      return (
        `    let ${name} = res.choice(${lookup}).expect("asked");\n` +
        `    if ${name}.confidence >= ${rustFloat(q.bar ?? CHOICE_GATE)} {\n` +
        `        println!("${name}: {}", ${name}.choice);\n` +
        `    } else {\n` +
        `        println!("${name}: unsure ({:.2}), send to a human", ${name}.confidence);\n` +
        `    }\n`
      );
    case "score":
      if (q.bar !== undefined) {
        return (
          `    let ${name} = res.score(${lookup}).expect("asked");\n` +
          `    if ${name}.confidence >= ${rustFloat(q.bar)} {\n` +
          `        println!("${name}: {:.2} of {} (confidence {:.2})", ${name}.score, ${name}.legend.len() - 1, ${name}.confidence);\n` +
          `    } else {\n` +
          `        println!("${name}: unsure ({:.2}), send to a human", ${name}.confidence);\n` +
          `    }\n`
        );
      }
      return (
        `    let ${name} = res.score(${lookup}).expect("asked");\n` +
        `    println!("${name}: {:.2} of {} (confidence {:.2})", ${name}.score, ${name}.legend.len() - 1, ${name}.confidence);\n`
      );
    default:
      return `    // ${name}: a raw question — read it from res.raw\n`;
  }
}
