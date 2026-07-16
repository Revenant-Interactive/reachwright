/**
 * D1 helpers — thin, explicit, no ORM. Every mutation writes an audit event.
 */

import { makeId, nowIso } from "./lib/validate.js";

export async function one(db, sql, ...binds) {
  return db.prepare(sql).bind(...binds).first();
}

export async function all(db, sql, ...binds) {
  const result = await db.prepare(sql).bind(...binds).all();
  return result?.results ?? [];
}

export async function run(db, sql, ...binds) {
  return db.prepare(sql).bind(...binds).run();
}

/** Audit trail for mutations. detail must already be redacted — no secrets, no raw chats. */
export async function audit(db, { actor, action, subjectType, subjectId, detail }) {
  await run(
    db,
    `INSERT INTO audit_events (id, actor, action, subject_type, subject_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    makeId("l"), actor || "operator", action, subjectType, subjectId || "",
    JSON.stringify(detail ?? {}), nowIso(),
  );
}

export function parseJsonColumn(value, fallbackValue) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallbackValue;
  } catch {
    return fallbackValue;
  }
}
