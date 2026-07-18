/**
 * Reachwright operator API — router, authentication boundary, and
 * security envelope. Single-operator system.
 *
 * Security model (docs/security-model.md):
 * - Every /api/* request requires Authorization: Bearer <OPERATOR_TOKEN>,
 *   compared in constant time. No token → 401, no detail leaked.
 * - Browser calls must present the exact configured APP_ORIGIN; non-browser
 *   tools (no Origin header) are allowed because the bearer token is the gate.
 * - Bearer-token auth means no cookies, hence no CSRF surface.
 * - Bodies are capped, JSON-only, validated against closed schemas.
 * - Responses: Cache-Control: no-store, nosniff. Errors are redacted.
 */

import { campaignRoutes } from "./routes/campaigns.js";
import { researchRoutes } from "./routes/research.js";
import { outreachRoutes } from "./routes/outreach.js";
import { qualifyRoutes } from "./routes/qualify.js";
import { reportRoutes } from "./routes/reports.js";
import { salesRoutes } from "./routes/sales.js";
import { clientRoutes } from "./routes/clients.js";
import { generationRoutes } from "./routes/generation.js";
import { marketRoutes } from "./routes/market.js";
import { providerStatus, generationSourcesStatus } from "./providers/registry.js";

const encoder = new TextEncoder();

function headers(env, extra = {}) {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": env.APP_ORIGIN || "null",
    vary: "Origin",
    ...extra,
  };
}

export function json(env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(env) });
}

export function error(env, status, message) {
  // Redacted operational errors: message is a short stable token, never a stack.
  return json(env, { error: message }, status);
}

async function timingSafeEqual(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i += 1) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function authorized(request, env) {
  if (!env.OPERATOR_TOKEN || env.OPERATOR_TOKEN.length < 16) return false; // refuse to run open
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) return false;
  return timingSafeEqual(header.slice(7), env.OPERATOR_TOKEN);
}

function originAllowed(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return true;                 // curl/tests: bearer token is the gate
  return origin === env.APP_ORIGIN;
}

export async function readBody(request, env) {
  const max = Number.parseInt(env.BODY_MAX_BYTES || "65536", 10);
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().startsWith("application/json")) return null;
  const text = await request.text();
  if (!text || encoder.encode(text).byteLength > max) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Route table: [method, pattern, handler]. :params captured by segment. */
const routes = [
  ...campaignRoutes,
  ...researchRoutes,
  ...outreachRoutes,
  ...qualifyRoutes,
  ...reportRoutes,
  ...salesRoutes,
  ...clientRoutes,
  ...generationRoutes,
  ...marketRoutes,
];

function matchRoute(method, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  outer: for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;
    const parts = pattern.split("/").filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params = {};
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(segments[i]);
      else if (parts[i] !== segments[i]) continue outer;
    }
    return { handler, params };
  }
  return null;
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: headers(env, {
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      }),
    });
  }

  if (!url.pathname.startsWith("/api/")) return error(env, 404, "not-found");
  if (!originAllowed(request, env)) return error(env, 403, "origin");
  if (!(await authorized(request, env))) return error(env, 401, "unauthorized");

  if (url.pathname === "/api/health" && request.method === "GET") {
    return json(env, {
      ok: true,
      provider: providerStatus(env),
      generation_sources: generationSourcesStatus(env),
      email_gate_passed: env.EMAIL_GATE_PASSED === "true",
    });
  }

  const matched = matchRoute(request.method, url.pathname);
  if (!matched) return error(env, 404, "not-found");
  return matched.handler({ request, env, params: matched.params, url });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      return error(env, 500, "internal"); // redacted; details go nowhere near the client
    }
  },
};
