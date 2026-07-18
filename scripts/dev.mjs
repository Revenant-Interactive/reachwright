/**
 * One-command local startup for the Reachwright operator.
 *
 *   npm run dev
 *
 * What it does, in order:
 *   1. Verifies dependencies (node_modules/wrangler) and fails with the fix.
 *   2. Ensures worker-api/.dev.vars exists; generates a random dev operator
 *      token on first run (never committed — .dev.vars is git-ignored).
 *   3. Applies every pending D1 migration to the local database. Existing
 *      local records are preserved; migrations only add.
 *   4. Starts the operator API (wrangler dev, port 8788) and serves the
 *      operator console (this process, port 8123, bound to 127.0.0.1 only).
 *   5. Prints the exact operator URL and the token to sign in with.
 *
 * Works with zero external accounts: no Apollo, no OpenRouter, no Calendly,
 * no Cloudflare resources. Hunter/Tavily keys are optional accelerators.
 * Ctrl+C stops both processes; local data survives restarts.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import process from "node:process";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const DEV_VARS = join(ROOT, "worker-api", ".dev.vars");
const API_PORT = 8788;
const APP_PORT = 8123;
// Invoke wrangler's JS entry directly through this Node — no npx, no .cmd
// shims, identical behavior on Windows and POSIX.
const WRANGLER = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// 1 — dependencies -----------------------------------------------------------
if (!existsSync(WRANGLER)) {
  fail("Dependencies missing. Run:  npm install   (in the repository root), then retry npm run dev.");
}

// 2 — dev operator token -----------------------------------------------------
if (!existsSync(DEV_VARS)) {
  const token = `dev-local-operator-token-${randomBytes(9).toString("hex")}`;
  writeFileSync(DEV_VARS, [
    "# Local development secrets — git-ignored, never commit.",
    `OPERATOR_TOKEN=${token}`,
    "# Optional provider keys (discovery accelerators; the app runs without them):",
    "# HUNTER_API_KEY=",
    "# TAVILY_API_KEY=",
    "",
  ].join("\n"), "utf8");
  console.log("Created worker-api/.dev.vars with a fresh dev operator token.");
}
const tokenLine = readFileSync(DEV_VARS, "utf8").split("\n")
  .find((line) => line.startsWith("OPERATOR_TOKEN="));
const operatorToken = tokenLine ? tokenLine.slice("OPERATOR_TOKEN=".length).replace(/^"|"$/g, "").trim() : "";
if (!operatorToken || operatorToken.length < 16) {
  fail("worker-api/.dev.vars has no usable OPERATOR_TOKEN (needs ≥16 chars). Fix or delete the file and rerun.");
}

// 3 — migrations -------------------------------------------------------------
console.log("Applying local D1 migrations (existing records are preserved)…");
const adopt = spawnSync(process.execPath, [WRANGLER, "d1", "execute", "reachwright", "--local", "--env", "dev",
  "--config", "worker-api/wrangler.toml", "--file", "scripts/adopt-local-migrations.sql"],
{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: false });
if (adopt.status !== 0) {
  console.error(String(adopt.stderr || adopt.stdout || adopt.error || "unknown wrangler failure"));
  fail("Local D1 bootstrap failed. The exact wrangler error is above.");
}
const migrate = spawnSync(process.execPath, [WRANGLER, "d1", "migrations", "apply", "reachwright", "--local",
  "--env", "dev", "--config", "worker-api/wrangler.toml"],
{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: false });
if (migrate.status !== 0) {
  console.error(String(migrate.stderr || migrate.stdout || migrate.error || "unknown wrangler failure"));
  fail("D1 migrations failed. The exact wrangler error is above.");
}
console.log("Migrations up to date.");

// 4a — operator API ----------------------------------------------------------
const api = spawn(process.execPath, [WRANGLER, "dev", "--config", "worker-api/wrangler.toml",
  "--env", "dev", "--local", "--port", String(API_PORT)],
{ cwd: ROOT, stdio: ["ignore", "inherit", "inherit"], shell: false });
api.on("exit", (code) => {
  console.error(`\nOperator API exited (${code}). Stopping.`);
  process.exit(code ?? 1);
});

// 4b — operator console (static server, loopback only) -----------------------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json",
  ".png": "image/png", ".ico": "image/x-icon" };
const appServer = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${APP_PORT}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = normalize(join(ROOT, pathname));
  // Never serve secrets or repo internals even on loopback.
  const blocked = [".dev.vars", ".git", "node_modules", ".wrangler", "CODEX-REVIEW", "CODEX-VERDICT"];
  if (!file.startsWith(ROOT) || blocked.some((part) => file.includes(part))) {
    response.writeHead(404); response.end("not found"); return;
  }
  try {
    const body = readFileSync(file);
    response.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404); response.end("not found");
  }
});
appServer.listen(APP_PORT, "127.0.0.1", () => {
  console.log([
    "",
    "──────────────────────────────────────────────────────",
    "  Reachwright operator is starting.",
    "",
    `  Operator console:  http://localhost:${APP_PORT}/app/`,
    `  API base URL:      http://localhost:${API_PORT}`,
    `  Operator token:    ${operatorToken}`,
    "",
    "  Sign in on the console with that API base and token.",
    "  Local data lives in worker-api/.wrangler/state and",
    "  survives restarts. Ctrl+C stops everything.",
    "──────────────────────────────────────────────────────",
    "",
  ].join("\n"));
});

function shutdown() {
  appServer.close();
  if (!api.killed) api.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
