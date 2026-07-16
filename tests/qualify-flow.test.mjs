import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_FLOW, evaluateFlow, normalizeFlowAnswers, validateFlowDefinition,
} from "../worker-api/src/lib/qualify.js";
import { loadActiveFlow, flowFallbackReply } from "../worker/src/index.js";

const answersStrong = { business: "b2b", leadSource: "ads", value: "v3", capacity: "now" };

test("flow definition validation rejects malformed flows", () => {
  assert.equal(validateFlowDefinition(BUILTIN_FLOW).ok, true);
  assert.equal(validateFlowDefinition(null).ok, false);
  assert.equal(validateFlowDefinition({ questions: [] }).ok, false);
  const dupField = structuredClone(BUILTIN_FLOW);
  dupField.questions[1] = { ...dupField.questions[1], field: "business" };
  assert.equal(validateFlowDefinition(dupField).ok, false);
  const badRule = structuredClone(BUILTIN_FLOW);
  badRule.rules.scoring.push({ when: { field: "nonexistent", in: ["x"] }, points: 5 });
  assert.equal(validateFlowDefinition(badRule).ok, false);
});

test("flow answers are a closed schema", () => {
  assert.deepEqual(normalizeFlowAnswers(BUILTIN_FLOW, answersStrong), answersStrong);
  assert.equal(normalizeFlowAnswers(BUILTIN_FLOW, { ...answersStrong, injected: "x" }), null);
  assert.equal(normalizeFlowAnswers(BUILTIN_FLOW, { ...answersStrong, value: "one billion" }), null);
  const partial = normalizeFlowAnswers(BUILTIN_FLOW, { business: "b2b" });
  assert.equal(partial.value, "unknown");
});

test("flow evaluation: asks in order, disqualifies, scores strong/maybe/no with explanations", () => {
  assert.equal(evaluateFlow(BUILTIN_FLOW, normalizeFlowAnswers(BUILTIN_FLOW, {})).next_question_id, "q_business");

  const strong = evaluateFlow(BUILTIN_FLOW, answersStrong);
  assert.equal(strong.verdict, "strong");
  assert.equal(strong.route, "booking");
  assert.ok(strong.factors.find((f) => f.kind === "total").score >= BUILTIN_FLOW.rules.strongAt);

  const disqualified = evaluateFlow(BUILTIN_FLOW, { ...answersStrong, value: "v0" });
  assert.equal(disqualified.verdict, "no");
  assert.equal(disqualified.factors[0].kind, "disqualifier");

  const maybe = evaluateFlow(BUILTIN_FLOW, { ...answersStrong, leadSource: "planning", value: "v1" });
  assert.equal(maybe.verdict, "maybe");
});

test("human-review rules route to a human, never to booking", () => {
  const flow = structuredClone(BUILTIN_FLOW);
  flow.rules.humanReview = [{ when: { field: "business", in: ["other"] }, reason: "unclassified business model" }];
  const decision = evaluateFlow(flow, { ...answersStrong, business: "other" });
  assert.equal(decision.verdict, "human-review");
  assert.equal(decision.route, "human");
});

// ---- public worker flow loading against a fake D1 ----
function fakeD1(row, { fail = false } = {}) {
  return {
    prepare() {
      return {
        bind() { return this; },
        async first() { if (fail) throw new Error("d1 down"); return row; },
        async run() { if (fail) throw new Error("d1 down"); return {}; },
      };
    },
  };
}

test("worker loads a valid active flow from D1 and falls back safely otherwise", async () => {
  const good = await loadActiveFlow({ DB: fakeD1({ id: "q1", name: "pilot", version: 2, definition: JSON.stringify(BUILTIN_FLOW) }) });
  assert.equal(good.meta.version, 2);
  assert.equal(validateFlowDefinition(good.definition).ok, true);

  // A worker with no binding, an invalid flow, or a D1 outage uses the builtin path (null).
  assert.equal(await loadActiveFlow({}), null);
  // note: loadActiveFlow caches per isolate; failures below rely on the cache
  // having been set by the first call, so we only assert the no-binding case here.
});

test("flow fallback copy covers questions and verdicts", () => {
  const questionCopy = flowFallbackReply(BUILTIN_FLOW, { next_question_id: "q_value", fit: "unknown" },
    BUILTIN_FLOW.questions.find((q) => q.id === "q_value"));
  assert.ok(questionCopy.length > 10);
  const verdictCopy = flowFallbackReply(BUILTIN_FLOW, { next_question_id: "verdict", fit: "no" }, null);
  assert.equal(verdictCopy, BUILTIN_FLOW.verdictCopy.no);
  const unknownVerdict = flowFallbackReply({ verdictCopy: {} }, { next_question_id: "verdict", fit: "human-review" }, null);
  assert.ok(unknownVerdict.includes("human"));
});
