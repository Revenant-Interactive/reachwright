/* Reachwright dual-workflow preview.
   This file makes no network requests and stores no visitor data. */
(function () {
  "use strict";

  var log = document.getElementById("rw-log");
  var choices = document.getElementById("rw-choices");
  var demo = document.getElementById("rw-demo");
  if (!log || !choices || !demo) return;

  var answers = {};
  var runId = 0;
  var timers = [];
  var busy = false;
  var hasInteracted = false;

  var script = {
    start: {
      says: [
        "Reachwright has two engines. Scout helps decide who is worth approaching. Qualify decides what should happen after someone responds.",
        "Which side do you want to inspect?"
      ],
      options: [
        { label: "Find new prospects", next: "scout_goal" },
        { label: "Qualify inbound leads", next: "qualify_business" },
        { label: "Explain both", next: "explain" }
      ]
    },
    explain: {
      says: [
        "Scout turns a written ideal-customer profile and public evidence into source-backed opportunity briefs. Nothing is sent without human approval.",
        "Qualify asks client-approved questions, applies fixed fit rules, and routes qualified or uncertain leads to the right human next step."
      ],
      options: [
        { label: "Preview Scout", next: "scout_goal" },
        { label: "Preview Qualify", next: "qualify_business" }
      ]
    },

    scout_goal: {
      says: ["What result should Scout create first?"],
      field: "scoutGoal",
      options: [
        { label: "Win website or app work", value: "projects", next: "scout_market" },
        { label: "Build a B2B sales pipeline", value: "pipeline", next: "scout_market" },
        { label: "Find partners or audiences", value: "partners", next: "scout_market" }
      ]
    },
    scout_market: {
      says: ["Which market should the first research run target?"],
      field: "scoutMarket",
      options: [
        { label: "Local service businesses", value: "local", next: "scout_geo" },
        { label: "Professional firms", value: "professional", next: "scout_geo" },
        { label: "Niche organizations", value: "niche", next: "scout_geo" },
        { label: "B2B technology companies", value: "technology", next: "scout_geo" }
      ]
    },
    scout_geo: {
      says: ["How narrow should the geography be?"],
      field: "scoutGeo",
      options: [
        { label: "One local market", value: "local", next: "scout_channel" },
        { label: "Regional", value: "regional", next: "scout_channel" },
        { label: "United States", value: "us", next: "scout_channel" },
        { label: "A specific market", value: "specific", next: "scout_channel" }
      ]
    },
    scout_channel: {
      says: ["What may Reachwright prepare after a prospect passes review?"],
      field: "scoutChannel",
      options: [
        { label: "Research briefs only", value: "research", next: "scout_result" },
        { label: "Email drafts", value: "email", next: "scout_result" },
        { label: "Manual social outreach", value: "social", next: "scout_result" },
        { label: "A reviewed channel mix", value: "mixed", next: "scout_result" }
      ]
    },

    qualify_business: {
      says: ["What kind of business would Qualify represent?"],
      field: "business",
      options: [
        { label: "Local service business", value: "local", next: "qualify_source" },
        { label: "B2B or professional services", value: "b2b", next: "qualify_source" },
        { label: "Consultative e-commerce", value: "ecom", next: "qualify_source" },
        { label: "Something else", value: "other", next: "qualify_source" }
      ]
    },
    qualify_source: {
      says: ["Where are the inbound conversations coming from?"],
      field: "leadSource",
      options: [
        { label: "Paid ads", value: "ads", next: "qualify_value" },
        { label: "Website or referrals", value: "organic", next: "qualify_value" },
        { label: "Replies to outreach", value: "outbound", next: "qualify_value" },
        { label: "Not active yet", value: "planning", next: "qualify_value" }
      ]
    },
    qualify_value: {
      says: ["Roughly what is a new customer worth in gross profit or first-year contribution?"],
      field: "value",
      options: [
        { label: "Under $500", value: "v0", next: "qualify_capacity" },
        { label: "$500 to $2K", value: "v1", next: "qualify_capacity" },
        { label: "$2K to $10K", value: "v2", next: "qualify_capacity" },
        { label: "$10K+", value: "v3", next: "qualify_capacity" },
        { label: "Not known yet", value: "unknown", next: "qualify_capacity" }
      ]
    },
    qualify_capacity: {
      says: ["If qualified conversations arrived this month, could the business handle them?"],
      field: "capacity",
      options: [
        { label: "Yes, now", value: "now", next: "qualify_result" },
        { label: "In a few weeks", value: "soon", next: "qualify_result" },
        { label: "No, still exploring", value: "explore", next: "qualify_result" }
      ]
    }
  };

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function schedule(fn, delay, id) {
    var timer = window.setTimeout(function () {
      timers = timers.filter(function (item) { return item !== timer; });
      if (id === runId) fn();
    }, delay);
    timers.push(timer);
  }

  function cancelPending() {
    timers.forEach(window.clearTimeout);
    timers = [];
  }

  function setBusy(value) {
    busy = value;
    demo.setAttribute("aria-busy", value ? "true" : "false");
  }

  function scrollLog() {
    log.scrollTop = log.scrollHeight;
  }

  function addBubble(text, mine) {
    var bubble = el("div", "bubble " + (mine ? "bubble-them" : "bubble-us"), text);
    log.appendChild(bubble);
    scrollLog();
    return bubble;
  }

  function showTyping() {
    var typing = el("div", "bubble bubble-us typing");
    typing.setAttribute("aria-hidden", "true");
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    typing.appendChild(el("span"));
    log.appendChild(typing);
    scrollLog();
    return typing;
  }

  function clearChoices() {
    choices.textContent = "";
  }

  function saySequence(lines, done, id) {
    var index = 0;
    function next() {
      if (index >= lines.length) {
        if (done) done();
        return;
      }
      var line = lines[index];
      var typing = showTyping();
      var delay = reducedMotion() ? 20 : Math.min(360 + line.length * 7, 900);
      schedule(function () {
        typing.remove();
        addBubble(line, false);
        index += 1;
        schedule(next, reducedMotion() ? 10 : 170, id);
      }, delay, id);
    }
    next();
  }

  function showOptions(node, id) {
    clearChoices();
    node.options.forEach(function (option) {
      var button = el("button", "choice-btn", option.label);
      button.type = "button";
      button.addEventListener("click", function () {
        if (busy || id !== runId) return;
        hasInteracted = true;
        setBusy(true);
        clearChoices();
        addBubble(option.label, true);
        if (node.field && option.value) answers[node.field] = option.value;
        schedule(function () {
          if (option.next === "scout_result") showScoutResult(id);
          else if (option.next === "qualify_result") showQualifyResult(id);
          else showNode(option.next, id);
        }, reducedMotion() ? 10 : 220, id);
      });
      choices.appendChild(button);
    });
    setBusy(false);
    if (hasInteracted && choices.firstElementChild) choices.firstElementChild.focus();
  }

  function showNode(key, id) {
    var node = script[key];
    if (!node || id !== runId) return;
    setBusy(true);
    saySequence(node.says, function () { showOptions(node, id); }, id);
  }

  function label(value, labels) {
    return labels[value] || "Not yet defined";
  }

  function addFactList(card, facts) {
    var list = el("dl", "result-facts");
    facts.forEach(function (fact) {
      var row = el("div", "result-fact");
      row.appendChild(el("dt", null, fact[0]));
      row.appendChild(el("dd", null, fact[1]));
      list.appendChild(row);
    });
    card.appendChild(list);
  }

  function renderResult(kind, eyebrow, title, body, facts, actionText, id) {
    if (id !== runId) return;
    var card = el("section", "verdict-card verdict-" + kind);
    card.tabIndex = -1;
    card.appendChild(el("div", "result-eyebrow", eyebrow));
    card.appendChild(el("h3", "verdict-title", title));
    card.appendChild(el("p", null, body));
    addFactList(card, facts);
    log.appendChild(card);

    var actions = el("div", "demo-actions");
    var discuss = el("a", "btn btn-primary", actionText);
    discuss.href = "#book";
    actions.appendChild(discuss);
    var restart = el("button", "demo-restart", "Run another workflow");
    restart.type = "button";
    restart.addEventListener("click", resetDemo);
    actions.appendChild(restart);
    log.appendChild(actions);
    setBusy(false);
    scrollLog();
    card.focus();
  }

  function showScoutResult(id) {
    var typing = showTyping();
    schedule(function () {
      typing.remove();
      var markets = { local: "local service businesses", professional: "professional firms", niche: "niche organizations", technology: "B2B technology companies" };
      var geos = { local: "one local market", regional: "a defined region", us: "the United States", specific: "a client-defined market" };
      var goals = { projects: "website or application opportunities", pipeline: "B2B pipeline opportunities", partners: "partnership or audience opportunities" };
      var channels = { research: "research briefs only", email: "approved email drafts", social: "manual social drafts", mixed: "a reviewed channel mix" };
      renderResult(
        "strong",
        "Illustrative Scout plan",
        "Start narrow enough to verify every claim.",
        "The first run should prove research quality before it attempts volume. Reachwright would return a small, reviewable batch with source URLs, observed dates, unknown fields, fit reasons, prior-contact checks, and an approval-ready approach. No real prospects were searched in this preview.",
        [
          ["Objective", label(answers.scoutGoal, goals)],
          ["Target", label(answers.scoutMarket, markets) + " in " + label(answers.scoutGeo, geos)],
          ["Deliverable", label(answers.scoutChannel, channels)],
          ["First gate", "Approve the ICP rubric and five sample dossiers before expansion"]
        ],
        "Discuss a Scout pilot",
        id
      );
    }, reducedMotion() ? 20 : 650, id);
  }

  function qualifyVerdict() {
    if (answers.capacity === "explore") {
      return {
        kind: "no",
        title: "Not ready for automation yet.",
        body: "There is no value in accelerating qualified demand into a business that cannot act on it. Define capacity, ownership, and a follow-up commitment first; then test the workflow.",
        action: "Review readiness with Michael"
      };
    }
    if (answers.value === "unknown") {
      return {
        kind: "maybe",
        title: "The economics are still unknown.",
        body: "Reachwright can route conversations, but it cannot honestly judge acquisition economics without a customer-value definition. Establish gross profit or first-year contribution and acceptable acquisition cost before scaling.",
        action: "Define the pilot economics"
      };
    }
    if (answers.value === "v0") {
      return {
        kind: "no",
        title: "A booked-call workflow may be too expensive.",
        body: "Under $500 in customer contribution, a human sales conversation can consume too much of the margin. A self-serve conversion path or lighter qualification flow is more likely to fit unless repeat value changes the math.",
        action: "Discuss the edge case"
      };
    }
    if (answers.business === "ecom" && answers.value !== "v3") {
      return {
        kind: "maybe",
        title: "Use qualification only if the sale needs a conversation.",
        body: "Most e-commerce should reduce friction, not add a call. This can fit wholesale, custom, or genuinely consultative purchases, but the decision rule must be proven against the buying journey.",
        action: "Pressure-test the workflow"
      };
    }
    if (answers.leadSource === "planning") {
      return {
        kind: "maybe",
        title: "Build the rules now; automate after real demand appears.",
        body: "There is no live response problem to measure yet. Define the qualification rubric and baseline process, then connect automation only after the first real leads expose where speed or consistency is failing.",
        action: "Design a measured pilot"
      };
    }
    return {
      kind: "strong",
      title: "This is worth a controlled pilot.",
      body: "The business has an active conversation source, workable customer economics, and near-term capacity. The next step is not a blanket AI launch: it is a small test with client-approved questions, deterministic routing, a human escape hatch, and held-call measurement.",
      action: "Discuss a Qualify pilot"
    };
  }

  function showQualifyResult(id) {
    var typing = showTyping();
    schedule(function () {
      typing.remove();
      var verdict = qualifyVerdict();
      var sources = { ads: "paid advertising", organic: "website traffic or referrals", outbound: "outbound replies", planning: "a channel that is not active yet" };
      var values = { v0: "under $500", v1: "$500 to $2K", v2: "$2K to $10K", v3: "$10K+", unknown: "not yet known" };
      renderResult(
        verdict.kind,
        "Deterministic Qualify verdict",
        verdict.title,
        verdict.body,
        [
          ["Lead source", label(answers.leadSource, sources)],
          ["Customer contribution", label(answers.value, values)],
          ["Capacity", answers.capacity === "now" ? "available now" : answers.capacity === "soon" ? "available in a few weeks" : "not available"],
          ["Production gate", "Client approves every question, rule, route, and fallback"]
        ],
        verdict.action,
        id
      );
    }, reducedMotion() ? 20 : 650, id);
  }

  function resetDemo() {
    cancelPending();
    runId += 1;
    answers = {};
    hasInteracted = true;
    log.textContent = "";
    clearChoices();
    showNode("start", runId);
  }

  showNode("start", runId);
})();
