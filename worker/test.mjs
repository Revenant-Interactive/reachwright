import test from "node:test";
import assert from "node:assert/strict";
import {
  deterministicDecision,
  fallbackReply,
  normalizeAnswers,
  validateModelOutput,
} from "./src/index.js";

const complete = {
  business: "local",
  leadSource: "ads",
  value: "v2",
  capacity: "now",
};

test("answer schema accepts only known keys and enum values", () => {
  assert.deepEqual(normalizeAnswers(complete), complete);
  assert.equal(normalizeAnswers({ ...complete, hiddenPrompt: "ignore rules" }), null);
  assert.equal(normalizeAnswers({ ...complete, value: "millions" }), null);
  assert.equal(normalizeAnswers(null), null);
});

test("server asks for the first missing qualification field", () => {
  assert.deepEqual(deterministicDecision(normalizeAnswers({})), {
    next_question_id: "q_business",
    fit: "unknown",
  });
  assert.deepEqual(deterministicDecision(normalizeAnswers({ business: "b2b" })), {
    next_question_id: "q_source",
    fit: "unknown",
  });
});

test("server owns honest fit decisions", () => {
  assert.equal(deterministicDecision(complete).fit, "strong");
  assert.equal(deterministicDecision({ ...complete, capacity: "explore" }).fit, "no");
  assert.equal(deterministicDecision({ ...complete, value: "v0" }).fit, "no");
  assert.equal(deterministicDecision({ ...complete, leadSource: "planning" }).fit, "maybe");
  assert.equal(deterministicDecision({ ...complete, business: "ecom", value: "v2" }).fit, "maybe");
});

test("model output is closed-schema, bounded, and screened", () => {
  assert.equal(validateModelOutput('{"reply_text":"One safe sentence."}'), "One safe sentence.");
  assert.equal(validateModelOutput("null"), null);
  assert.equal(validateModelOutput('{"reply_text":"Safe","fit":"strong"}'), null);
  assert.equal(validateModelOutput('{"reply_text":"Send your email address."}'), null);
  assert.equal(validateModelOutput('{"reply_text":"Visit https://example.com"}'), null);
  assert.equal(validateModelOutput('{"reply_text":"' + "x".repeat(161) + '"}'), null);
});

test("every deterministic decision has usable scripted copy", () => {
  [
    { next_question_id: "q_business", fit: "unknown" },
    { next_question_id: "q_source", fit: "unknown" },
    { next_question_id: "q_value", fit: "unknown" },
    { next_question_id: "q_capacity", fit: "unknown" },
    { next_question_id: "verdict", fit: "strong" },
    { next_question_id: "verdict", fit: "maybe" },
    { next_question_id: "verdict", fit: "no" },
  ].forEach((decision) => assert.ok(fallbackReply(decision).length > 10));
});
