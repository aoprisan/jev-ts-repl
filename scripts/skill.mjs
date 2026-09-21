/**
 * The skill, as a module: `skills/jev/SKILL.md` is the copy people read and edit, and this turns
 * it into `src/agent/skill.ts` so the built binary carries it with no file to find at run time.
 *
 * Run `npm run skill` after editing the markdown; `test/agent.test.ts` fails when the two drift.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "skills/jev/SKILL.md");
const OUT = resolve(ROOT, "src/agent/skill.ts");

const markdown = readFileSync(SOURCE, "utf8");

const module = `/**
 * The jev skill: what an agent reads to write a page that parses and a request worth sending.
 *
 * Generated from \`skills/jev/SKILL.md\` by \`npm run skill\` — edit the markdown, not this file.
 */

/** The directory a skill is installed under, and the name agents call it by. */
export const SKILL_NAME = "jev";

/** The file every host reads the skill out of. */
export const SKILL_FILE = "SKILL.md";

/** The skill itself: YAML frontmatter, then the instructions. */
export const SKILL_MD = ${JSON.stringify(markdown)};
`;

writeFileSync(OUT, module);
process.stdout.write(`skill: ${markdown.length} bytes -> ${OUT.slice(ROOT.length + 1)}\n`);
