# Reachwright compliance boundaries

_Hard rules. No prompt, config, or convenience overrides these._

## Outreach

1. **No automatic sending exists in this system.** Export produces CSV/copyable text; a human sends, one approved message at a time. This is architecture, not policy — there is no send code to misconfigure.
2. **Commercial email is gated** (`EMAIL_GATE_PASSED=false`) until ALL of: truthful sender identity, subject lines that aren't deceptive, clear ad identification where required, a **valid physical postal address**, a working unsubscribe path honored within **10 business days**, and suppression storage with an accountable owner. Vendor use does not transfer responsibility. Reference: [FTC CAN-SPAM compliance guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business) — it covers B2B email.
3. **LinkedIn is manual, always.** No scraping, no automated visits/connections/messages, no harvesting extensions ([LinkedIn prohibited software policy](https://www.linkedin.com/help/linkedin/answer/a1341387)). Scout may prepare a draft from inspectable facts; Michael copies and sends it by hand.
4. **Contact policy:** one person per company at a time; one manual follow-up after 7+ days of silence, then a ≥30-day company cooling period; automated follow-up prohibited outright.
5. **Opt-outs expand:** a stop on any channel suppresses the person AND company across all channels (email, domain, phone, handle, org, alias keys), enforced at three checkpoints (research, approval, export).

## Data and claims

6. **No invented prospect facts.** Drafts assemble only from accepted first-party/authoritative evidence; missing evidence yields the literal "insufficient evidence for personalized outreach." The generator may not invent revenue, budgets, ad spend, business problems, family information, statistics, partnerships, technology use, urgency, or personal familiarity.
7. **Unknown is a required state.** Missing evidence is recorded as unknown, never guessed.
8. **No sensitive personal traits, ever.** Public availability is not permission to collect.
9. **Provider data is licensed, not owned** — see `docs/providers/apollo.md`; reveals of personal emails/phones stay disabled.

## Public claims

10. **No fake testimonials, usage numbers, or campaign results.** Only audited pilot metrics with client authorization.
11. **No "LLC" suffix** anywhere until the entity legally exists.
12. **Nothing is called live until its activation gates pass** (PLAN.md rev 5 lists Scout and Qualify gates separately). Public copy must keep distinguishing deployed capability from configured-but-inactive capability.
13. **Honest metric names:** candidates ≠ leads until they pass the campaign threshold; booked ≠ held. The reporting layer enforces this in its own labels.

## Qualify conversations

14. The public conversation never asks for names, emails, or phone numbers; a sensitive-input filter rejects them if volunteered. Contact details enter only at a separately disclosed booking step.
15. The AI cannot choose or alter a verdict; rules are operator-approved and deterministic; every provider failure degrades to scripted copy.
