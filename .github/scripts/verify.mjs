#!/usr/bin/env node
// ============================================================
// CI verification suite for the HPF Digital Portal.
//
// Runs entirely on Node built-ins -- no dependencies, matching this repo's
// own zero-build-step, zero-dependency application code (see README.md,
// deploy.yml's own header comment). Runnable locally exactly as it runs in
// CI:
//
//   node .github/scripts/verify.mjs
//
// Implements checks 1-7 and the pure-module half of 8 (smoke tests) from
// supabase's sibling CI docs -- see CI.md at the repo root for the full
// pipeline this script is one stage of.
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
process.chdir(ROOT);

let failed = 0;
let checked = 0;

function section(name) {
  console.log(`\n\x1b[1m── ${name} ──\x1b[0m`);
}
function pass(msg) {
  checked++;
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function fail(msg) {
  checked++;
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
}

const tracked = trackedFiles();
// .claude/ and .agents/ hold vendored editor/skill tooling and its own
// documentation, not this project's application code -- and that
// documentation deliberately contains example secret-shaped strings to
// teach the naming convention (e.g. "sb_secret_..." as a placeholder),
// which would otherwise make checks 5/6 fail on text that was never a real
// credential. Out of scope for every check below, the same way it's out of
// scope for the running app itself.
const isTooling = (f) => f.startsWith(".claude/") || f.startsWith(".agents/");
const jsFiles = tracked.filter((f) => f.endsWith(".js") && !isTooling(f));
const jsonFiles = tracked.filter((f) => f.endsWith(".json") && !isTooling(f));

/* ============================================================ 1. JS syntax */
section("1 · JavaScript syntax (node --check)");
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
    pass(f);
  } catch (err) {
    const detail = (err.stderr?.toString() || err.message).trim().split("\n").slice(0, 3).join(" / ");
    fail(`${f} — ${detail}`);
  }
}

/* ============================================================ 2. JSON validity */
section("2 · JSON validity");
for (const f of jsonFiles) {
  try {
    JSON.parse(readFileSync(f, "utf8"));
    pass(f);
  } catch (err) {
    fail(`${f} — ${err.message}`);
  }
}

/* ============================================================ 3. Broken references */
section("3 · Local file references resolve");

// A ref may be a plain relative path (index.html's own convention: "./app.js")
// or a root-absolute path carrying the GitHub Pages project-site prefix
// (404.html's deliberate convention: "/HPF-digital-portal-2026/app.js", see
// VERCEL.md on why that file is intentionally different from index.html).
// Try both readings before calling a reference broken.
function resolveRef(ref) {
  const clean = ref.split(/[?#]/)[0].replace(/^\.\//, "");
  const asIs = clean.replace(/^\//, "");
  if (existsSync(path.join(ROOT, asIs))) return asIs;
  const stripped = asIs.replace(/^HPF-digital-portal-2026\//, "");
  if (stripped !== asIs && existsSync(path.join(ROOT, stripped))) return stripped;
  return null;
}

function checkHtmlRefs(file) {
  const html = readFileSync(file, "utf8");
  const re = /(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1];
    if (/^([a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:") || ref.startsWith("#")) continue;
    const resolved = resolveRef(ref);
    if (resolved) pass(`${file} → ${ref}`);
    else fail(`${file} → ${ref} (no matching file found)`);
  }
}
checkHtmlRefs("index.html");
checkHtmlRefs("404.html");

function checkJsImports(file) {
  const src = readFileSync(file, "utf8");
  const re = /\bfrom\s+["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue; // remote (https://esm.sh/...) or bare specifiers: not a local reference
    const resolved = path.join(path.dirname(file), spec);
    if (existsSync(resolved)) pass(`${file} → ${spec}`);
    else fail(`${file} → ${spec} (no file at ${path.relative(ROOT, resolved)})`);
  }
}
for (const f of jsFiles) checkJsImports(f);

/* ============================================================ 4. Required files */
section("4 · Required application files present");
const REQUIRED = [
  "index.html", "404.html", "app.js", "dashboards.js", "data.js", "util.js",
  "supabase.js", "recovery.js", "icons.js", "config.js", "styles.css",
  "vercel.json", ".github/workflows/deploy.yml",
];
for (const f of REQUIRED) {
  if (existsSync(path.join(ROOT, f))) pass(f);
  else fail(`${f} — missing`);
}

/* ============================================================ 5. No tracked secrets */
section("5 · No tracked secrets");
if (tracked.includes(".env")) fail(".env is tracked — it must never be committed (see .gitignore's own header comment)");
else pass(".env is not tracked");

const SECRET_PATTERNS = [
  { name: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: "a PEM private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "a generic secret-shaped assignment", re: /\b(API_KEY|SECRET|SERVICE_ROLE(?:_KEY)?|DB_PASSWORD)\s*[:=]\s*["'][A-Za-z0-9_\-/+]{16,}["']/ },
];
// Binary/asset files can't be read as text and can't hold a plausible text
// secret either -- skip them rather than let a decode error abort the run.
const BINARY_EXT = /\.(png|jpe?g|ico|gif|svg|woff2?|zip|ttf|eot)$/i;
let secretHits = 0;
let secretScanned = 0;
for (const f of tracked) {
  if (BINARY_EXT.test(f) || isTooling(f)) continue;
  let content;
  try {
    content = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  secretScanned++;
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      fail(`${f} — contains what looks like ${name}`);
      secretHits++;
    }
  }
}
if (!secretHits) pass(`no secret-shaped strings found across ${secretScanned} tracked files`);

/* ============================================================ 6. No demo credentials */
section("6 · No accidental demo credentials in application code");
// Scoped to code and config the running app actually reads -- .js, .sql,
// .json -- not prose documentation. A doc *describing* a credential is a
// documentation-accuracy problem (tracked separately); this check exists to
// catch a credential the app could actually authenticate with.
// supabase/seed-dev.sql is excluded on purpose: its own header marks it
// explicitly non-production, fake data never run against the live database
// (see supabase/SETUP.md, "Do not run seed-dev.sql against this project").
const DEMO_PATTERNS = [
  /admin1234/i, /password123/i, /demo1234/i, /test1234/i, /\bchangeme\b/i,
  /\bpassword\s*[:=]\s*["']admin["']/i,
];
const codeFiles = tracked.filter(
  (f) =>
    (f.endsWith(".js") || f.endsWith(".sql") || f.endsWith(".json")) &&
    f !== "supabase/seed-dev.sql" &&
    !isTooling(f)
);
let demoHits = 0;
for (const f of codeFiles) {
  let content;
  try {
    content = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const re of DEMO_PATTERNS) {
    if (re.test(content)) {
      fail(`${f} — matches a known demo-credential pattern (${re})`);
      demoHits++;
    }
  }
}
if (!demoHits) pass(`no demo-credential patterns found across ${codeFiles.length} code/config files`);

/* ============================================================ 7. Routes have handlers */
section("7 · Every route has a real handler");
const appSrc = readFileSync("app.js", "utf8");
const routesBlock = appSrc.match(/const ROUTES = \{([\s\S]*?)\n\};/);
if (!routesBlock) {
  fail("could not find `const ROUTES = {...}` in app.js — has its shape changed?");
} else {
  const entryRe = /"([^"]+)":\s*(\(\)\s*=>\s*[A-Za-z_$][\w$]*\([^)]*\)|[A-Za-z_$][\w$]*)/g;
  let m;
  let routeCount = 0;
  const routeKeys = [];
  while ((m = entryRe.exec(routesBlock[1]))) {
    routeCount++;
    const [, routePath, handlerExpr] = m;
    routeKeys.push(routePath);
    const handlerName = (handlerExpr.match(/([A-Za-z_$][\w$]*)\s*\(/) || handlerExpr.match(/^([A-Za-z_$][\w$]*)$/))?.[1];
    if (!handlerName) {
      fail(`${routePath} — could not identify a handler name in "${handlerExpr}"`);
      continue;
    }
    const defined =
      new RegExp(`\\bfunction\\s+${handlerName}\\b`).test(appSrc) ||
      new RegExp(`\\bconst\\s+${handlerName}\\s*=`).test(appSrc) ||
      new RegExp(`\\bimport\\b[^;]*\\b${handlerName}\\b`).test(appSrc);
    if (defined) pass(`${routePath} → ${handlerName}()`);
    else fail(`${routePath} → ${handlerName}() is not defined or imported anywhere in app.js`);
  }
  if (!routeCount) {
    fail("ROUTES block found but zero route entries were parsed out of it — check this script's regex against app.js's current shape");
  } else {
    pass(`parsed ${routeCount} route(s) out of ROUTES`);
  }

  const titleBlock = appSrc.match(/function titleFor[\s\S]*?const map = \{([\s\S]*?)\n {2}\};/);
  if (!titleBlock) {
    fail("could not find titleFor()'s `const map = {...}` in app.js");
  } else {
    for (const key of routeKeys) {
      if (titleBlock[1].includes(`"${key}"`)) pass(`titleFor() has an entry for ${key}`);
      else fail(`titleFor() has no title for route ${key} — it will fall back to "Page not found"`);
    }
  }
}

/* ============================================================ 8a. Smoke test: pure modules */
section("8 · Smoke tests — browser-independent modules import and export cleanly");
// node --check (step 1) only parses -- it never executes a module or
// resolves its imports, so it can't catch a broken export name or an import
// specifier that resolves to the wrong thing. This actually imports the
// modules that have no DOM or network dependency at load time.
const SMOKE_MODULES = [
  { file: "./util.js", expect: ["BASE", "$", "$$", "toast", "esc", "read", "write", "runCounters"] },
  { file: "./icons.js", expect: ["icon"] },
  { file: "./data.js", expect: ["COUNTIES", "ROLES"] },
  { file: "./config.js", expect: ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"] },
];
for (const { file, expect } of SMOKE_MODULES) {
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, file)));
    const missing = expect.filter((name) => !(name in mod));
    if (missing.length) fail(`${file} imported, but is missing expected export(s): ${missing.join(", ")}`);
    else pass(`${file} imports cleanly — exports ${expect.join(", ")}`);
  } catch (err) {
    fail(`${file} threw on import: ${err.message}`);
  }
}
// app.js / dashboards.js / recovery.js touch real DOM globals at module
// scope (document.addEventListener, ...); supabase.js imports from a
// remote https://esm.sh/... specifier bare Node can't resolve. Neither is a
// gap in coverage -- see 8b (smoke-serve.sh) for the check that actually
// exercises these by serving the real static files and requesting them.
console.log("  (app.js/dashboards.js/recovery.js/supabase.js need a DOM or a network-capable module loader — covered by .github/scripts/smoke-serve.sh's serve-and-fetch check instead, not skipped)");

/* ============================================================ summary */
section("Summary");
console.log(`  ${checked - failed}/${checked} checks passed.`);
if (failed) {
  console.log(`\n\x1b[31m${failed} check(s) failed.\x1b[0m`);
  process.exit(1);
}
console.log(`\n\x1b[32mAll checks passed.\x1b[0m`);
