/**
 * Test-only D1 shim over node:sqlite (Node ≥22.5). Runs the REAL migration
 * SQL, so route handlers are tested against the actual schema and real SQL
 * semantics — not a hand-rolled mock's guesses.
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS = ["0001_init.sql", "0002_pilot_workflow.sql", "0003_audit_evidence_fingerprint.sql",
  "0004_score_evidence_fingerprint.sql", "0005_dossier_audit_checklist.sql",
  "0006_sales_call_console.sql", "0007_generation_engine.sql",
  "0008_client_attribution_and_feedback.sql", "0009_generation_quality_evidence.sql",
  "0010_copywriting_market_model.sql", "0011_prospect_feed.sql",
  "0012_heading_opportunity_alignment.sql", "0013_generic_contact_cleanup.sql",
  "0014_copy_signal_precision.sql", "0015_revenue_plan.sql"].map((name) => readFileSync(
  fileURLToPath(new URL(`../../migrations/${name}`, import.meta.url)), "utf8",
));

export function createFakeD1() {
  const db = new DatabaseSync(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration);
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
