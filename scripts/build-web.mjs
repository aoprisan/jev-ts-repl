/**
 * Build the web REPL into `site/`: a static directory with no server behind it.
 *
 * The app is compiled to plain ES modules and the core is copied beside it, so the browser loads
 * exactly what TypeScript checked — no bundler, no runtime dependency. The service worker's
 * precache list is generated from what actually landed, which is what makes "offline" true rather
 * than hopeful.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");

const run = (...args) =>
  execFileSync(process.execPath, [TSC, ...args], { cwd: ROOT, stdio: "inherit" });

/** Every file under `dir`, as paths relative to `SITE`, sorted for a stable precache list. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(relative(SITE, full).split("\\").join("/"));
  }
  return out.sort();
}

rmSync(SITE, { recursive: true, force: true });
mkdirSync(SITE, { recursive: true });

// 1. The core, compiled and copied in. Only the modules — declarations and maps stay out of the site.
run("-p", "tsconfig.build.json");
cpSync(join(ROOT, "dist"), join(SITE, "core"), {
  recursive: true,
  filter: (src) => statSync(src).isDirectory() || src.endsWith(".js"),
});

// 2. The app.
run("-p", "tsconfig.web.json");

// 3. The static shell. The page carries its own Content-Security-Policy, and the only inline
//    script it has is the import map — so the policy names that script by hash, computed here from
//    what is actually between the tags. Change the map and the hash follows; get it wrong and the
//    browser refuses to run it, which is the point.
const html = readFileSync(join(ROOT, "web", "index.html"), "utf8");
const inline = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
if (!inline) throw new Error("web/index.html has no import map to hash");
if (!html.includes("__IMPORTMAP_HASH__")) {
  throw new Error("web/index.html has no __IMPORTMAP_HASH__ for the policy");
}
const inlineHash = `sha256-${createHash("sha256").update(inline[1], "utf8").digest("base64")}`;
writeFileSync(join(SITE, "index.html"), html.replace("__IMPORTMAP_HASH__", inlineHash));

for (const name of ["styles.css", "manifest.webmanifest"]) {
  cpSync(join(ROOT, "web", name), join(SITE, name));
}
cpSync(join(ROOT, "web", "icons"), join(SITE, "icons"), { recursive: true });

// 4. The worker, stamped with what is there and a version that changes when any of it does.
const assets = walk(SITE);
const digest = createHash("sha256");
for (const name of assets) digest.update(name).update(readFileSync(join(SITE, name)));
const version = digest.digest("hex").slice(0, 12);
const worker = readFileSync(join(ROOT, "web", "sw.js"), "utf8")
  .replace("__VERSION__", version)
  .replace("__PRECACHE__", JSON.stringify(["./", ...assets.map((a) => `./${a}`)], null, 2));
writeFileSync(join(SITE, "sw.js"), worker);

// 5. GitHub Pages serves `site/` as it is; this keeps it from running the files through Jekyll.
writeFileSync(join(SITE, ".nojekyll"), "");

const bytes = assets.reduce((total, name) => total + statSync(join(SITE, name)).size, 0);
console.log(`site/ · ${assets.length + 1} files · ${(bytes / 1024).toFixed(0)} KiB · ${version}`);
