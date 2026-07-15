/* ============================================================
   Reachwright — scripted qualification demo
   Runs 100% in the browser. No network calls, no storage of
   personal data (we never ask for any). This scripted track is
   also the permanent fallback once live-AI mode ships: set
   LIVE_ENDPOINT to the Worker URL to enable live mode.
   ============================================================ */

(function () {
  "use strict";

  var LIVE_ENDPOINT = null; // Cloudflare Worker URL once deployed; null = scripted mode

  var log = document.getElementById("rw-log");
  var choices = document.getElementById("rw-choices");
  if (!log || !choices) return;

  // -------- conversation state --------
  var answers = {};

  // -------- script definition --------
  var script = {
    start: {
      says: [
        "I'm Reachwright's qualifier — the same interview prospects get after they tap your ad.",
        "Four questions, sixty seconds, and I'll tell you straight whether this engine fits your business. Even if the answer is no. Fair?"
      ],
      options: [
        { label: "Let's go", next: "q_business" },
        { label: "Wait — what is this?", next: "explain" }
      ]
    },
    explain: {
      says: [
        "Reachwright books qualified sales calls straight from ads — no landing page. An AI answers every hand-raise in seconds, qualifies against the client's written criteria, and books the good ones onto their calendar.",
        "Right now it's qualifying you. Ready?"
      ],
      options: [{ label: "Okay, let's go", next: "q_business" }]
    },
    q_business: {
      says: ["What kind of business are you running?"],
      field: "business",
      options: [
        { label: "Local service business", value: "local", next: "q_ads" },
        { label: "B2B / professional services", value: "b2b", next: "q_ads" },
        { label: "E-commerce", value: "ecom", next: "q_ads" },
        { label: "Something else", value: "other", next: "q_ads" }
      ]
    },
    q_ads: {
      says: ["Are you running paid ads right now?"],
      field: "ads",
      options: [
        { label: "Yes, actively", value: "yes", next: "q_value" },
        { label: "Have before — paused", value: "paused", next: "q_value" },
        { label: "Not yet, planning to", value: "planning", next: "q_value" }
      ]
    },
    q_value: {
      says: ["What's a typical customer worth to you, roughly?"],
      field: "value",
      options: [
        { label: "Under $500", value: "v0", next: "q_capacity" },
        { label: "$500 – $2K", value: "v1", next: "q_capacity" },
        { label: "$2K – $10K", value: "v2", next: "q_capacity" },
        { label: "$10K+", value: "v3", next: "q_capacity" }
      ]
    },
    q_capacity: {
      says: ["Last one. If qualified calls started landing on your calendar this month — could you actually take them?"],
      field: "capacity",
      options: [
        { label: "Yes — send them", value: "now", next: "verdict" },
        { label: "In a few weeks", value: "soon", next: "verdict" },
        { label: "Just exploring", value: "explore", next: "verdict" }
      ]
    }
  };

  // -------- verdict logic (deterministic, honest) --------
  function computeVerdict() {
    var score = 0;
    score += { yes: 3, paused: 2, planning: 1 }[answers.ads] || 0;
    score += { v0: 0, v1: 1, v2: 2, v3: 3 }[answers.value] || 0;
    score += { now: 2, soon: 1, explore: 0 }[answers.capacity] || 0;
    score += { local: 1, b2b: 1, other: 1, ecom: 0 }[answers.business] || 0;

    var lowValue = answers.value === "v0";
    var ecom = answers.business === "ecom";

    if (lowValue) {
      return {
        kind: "no",
        title: "Straight answer: probably not yet.",
        body: "Under $500 per customer, the economics of booked sales calls get tight — every held call has to close just to break even. You'd likely get more from tightening your offer or pricing first. When your customer value climbs, come back; an engine that books wrong-fit calls would be stealing from you.",
        cta: "disagree"
      };
    }
    if (ecom && score < 6) {
      return {
        kind: "no",
        title: "Straight answer: this engine wants a phone call at the end — most e-commerce doesn't.",
        body: "If you're selling carts, not conversations, Reachwright isn't your next move. High-ticket or consultative e-commerce (custom, wholesale, B2B supply) is a different story — if that's you, book the call and say so.",
        cta: "disagree"
      };
    }
    if (score >= 6) {
      return {
        kind: "strong",
        title: "You're exactly who this was built for.",
        body: "You're already paying for attention — the leak is what happens in the minutes after someone raises a hand. That's the exact race this engine wins. Book the strategy call and bring your current cost per lead; we'll do the math on your real numbers, in front of you.",
        cta: "book"
      };
    }
    return {
      kind: "maybe",
      title: "Workable — with caveats.",
      body: "The fit is real but not screaming: " +
        (answers.ads === "planning" ? "you're not running ads yet, so the engine would launch alongside your first campaigns rather than fixing live ones. " : "") +
        (answers.capacity === "explore" ? "And you're exploring rather than ready, which is honestly fine — better to look before money moves. " : "") +
        "Book the call if you want the honest version with your real numbers in it.",
      cta: "book"
    };
  }

  // -------- rendering --------
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function scrollLog() { log.scrollTop = log.scrollHeight; }

  function addBubble(text, mine) {
    log.appendChild(el("div", "bubble " + (mine ? "bubble-them" : "bubble-us"), text));
    scrollLog();
  }

  function showTyping() {
    var t = el("div", "bubble bubble-us typing");
    t.appendChild(el("span")); t.appendChild(el("span")); t.appendChild(el("span"));
    t.setAttribute("data-typing", "1");
    log.appendChild(t);
    scrollLog();
    return t;
  }

  function clearChoices() { choices.textContent = ""; }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function saySequence(lines, done) {
    var i = 0;
    function next() {
      if (i >= lines.length) { done && done(); return; }
      var typing = showTyping();
      var delay = reducedMotion() ? 40 : Math.min(500 + lines[i].length * 12, 1400);
      setTimeout(function () {
        typing.remove();
        addBubble(lines[i], false);
        i++;
        setTimeout(next, reducedMotion() ? 20 : 250);
      }, delay);
    }
    next();
  }

  function showNode(key) {
    var node = script[key];
    if (!node) return;
    saySequence(node.says, function () {
      clearChoices();
      node.options.forEach(function (opt) {
        var b = el("button", "choice-btn", opt.label);
        b.type = "button";
        b.addEventListener("click", function () {
          clearChoices();
          addBubble(opt.label, true);
          if (node.field && opt.value) answers[node.field] = opt.value;
          if (opt.next === "verdict") showVerdict();
          else setTimeout(function () { showNode(opt.next); }, reducedMotion() ? 20 : 350);
        });
        choices.appendChild(b);
      });
    });
  }

  function showVerdict() {
    var v = computeVerdict();
    var typing = showTyping();
    setTimeout(function () {
      typing.remove();

      var card = el("div", "verdict-card verdict-" + v.kind);
      card.appendChild(el("div", "verdict-title", v.title));
      card.appendChild(el("p", null, v.body));
      log.appendChild(card);

      var actions = el("div", "demo-actions");
      var book = el("a", "btn btn-primary", v.cta === "disagree" ? "Think I'm wrong? Book the call" : "Book the strategy call");
      book.href = "#book";
      actions.appendChild(book);

      var restart = el("button", "demo-restart", "run it again");
      restart.type = "button";
      restart.addEventListener("click", function () {
        answers = {};
        log.textContent = "";
        clearChoices();
        showNode("start");
      });
      actions.appendChild(restart);

      log.appendChild(actions);
      scrollLog();
    }, reducedMotion() ? 40 : 1100);
  }

  // -------- live-mode adapter (future) --------
  // When LIVE_ENDPOINT is set, the same UI submits user choices to the
  // Cloudflare Worker and renders its validated JSON verdicts; any
  // failure (timeout, 429, malformed) falls back to this scripted track
  // carrying the answers collected so far. See worker/README notes.

  showNode("start");
})();
