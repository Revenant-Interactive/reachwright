/**
 * Test-only D1 shim over node:sqlite (Node ≥22.5). Runs the REAL migration
 * SQL, so route handlers are tested against the actual schema and real SQL
 * semantics — not a hand-rolled mock's guesses.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../migrations/0001_init.sql", import.meta.url)),
  "utf8",
);

export function createFakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);
  return {
    prepare(sql) {
      const statement = { binds: [] };
      statement.bind = (...args) => {
        statement.binds = args.map((value) => (value === undefined ? null : value));
        return statement;
      };
      statement.first = async () => db.prepare(sql).get(...statement.binds) ?? null;
      statement.all = async () => ({ results: db.prepare(sql).all(...statement.binds) });
      statement.run = async () => {
        const info = db.prepare(sql).run(...statement.binds);
        return { success: true, meta: info };
      };
      return statement;
    },
    _raw: db,
  };
}
