# RUN-TONIGHT — start the Reachwright operator locally

The private operator console runs entirely on your machine. No Apollo, no
OpenRouter, no Calendly, no Cloudflare account, and no paid key is required.
Hunter/Tavily keys are optional discovery accelerators, not prerequisites.

## Prerequisites

- Node.js 20+ (`node --version`)
- npm (ships with Node)
- Nothing else. Python is not required (the dev script serves the console itself).

## First run

```
cd E:\workspaces\reachwright
npm install
npm run dev
```

`npm run dev` does everything in order and tells you exactly what failed if
something is misconfigured:

1. verifies dependencies;
2. creates `worker-api/.dev.vars` with a random dev operator token if missing
   (git-ignored; never committed);
3. applies every pending D1 migration to the local database, preserving
   existing local records;
4. starts the operator API on port 8788 and the console on port 8123
   (loopback only — nothing is exposed to your network);
5. prints the operator URL and the token.

## Normal startup (every night after)

```
cd E:\workspaces\reachwright
npm run dev
```

## Operator URL and sign-in

- Open **http://localhost:8123/app/**
- API base URL: `http://localhost:8788` (prefilled)
- Operator token: printed by `npm run dev` (it lives in
  `worker-api/.dev.vars` under `OPERATOR_TOKEN=`)
- Press **Unlock**. You land on **Today**.

## Where your data lives / persistence

- Local D1 state: `worker-api/.wrangler/state/` (git-ignored).
- Everything you create — campaigns, services, signals, scoring edits,
  dossiers, runs — persists across restarts.
- Deleting `worker-api/.wrangler/state/` is the only way to lose local data;
  don't.

## Stop and restart

- **Stop:** Ctrl+C in the `npm run dev` terminal (stops API and console).
- **Restart:** `npm run dev` again. Data is still there.

## The operator loop

1. **Today** is the primary workspace. With a live Hunter key configured, the
   local app automatically replenishes the broad Copywriting opportunity feed
   at most once per 24 hours. It searches distinct market lanes, researches
   official sites, rejects candidates without visible capacity, and shows only
   real review-ready prospects. Fixtures and browser-test campaigns are hidden.
2. Read the **$10k recurring-revenue path** on Today. It shows the current
   bottleneck and links to **Revenue**, where the target, actual confirmed MRR,
   reverse-planned funnel, and editable assumptions live.
3. Open a prospect card. Verify the cited source, decision-maker, exact contact
   route, recommended service, six market scores, and proposed messages.
4. Confirm one packet to create one unsent draft. Send manually on the selected
   channel, then record the send and eventual outcome.
5. Use **Find fresh prospects** on Today when you deliberately want another
   bounded run. The default ceiling is 40 candidates across twelve market
   lanes; the run still stops at five qualified packets.
6. **Generate**, **Market**, **Clients**, and **Campaigns** remain available for
   advanced controls. They are no longer prerequisites for starting work.

The queue is intentionally strict. A missing page heading is a technical
observation, not a reason to pitch copywriting. Careers-page navigation or
service copy is not a hiring signal. A message-ready prospect needs an actual
copy opportunity, a capacity/buying trigger, current evidence, and a verified
permitted contact route. A smaller honest queue is success.

## What remains blocked for production (deliberately)

- **Nothing is deployed.** The operator API and console are local-only.
- **No message can be sent from this system.** No send code exists; outreach
  is prepared, approved, and manually sent by you.
- **Commercial email is blocked** until sender identity, a valid postal
  address, opt-out handling, and suppression are configured
  (`EMAIL_GATE_PASSED=false`).
- **Production Cloudflare resources, provider keys, and custom domain** — each
  is your explicit call, per the launch gates in README.md. The public Cal.com
  fit-call event is live; record booked and held outcomes honestly in the
  operator console until a reviewed integration replaces manual entry.
