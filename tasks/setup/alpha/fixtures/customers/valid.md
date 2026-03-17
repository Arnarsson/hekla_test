Customer: Christopher James Lüscher

## Identity

- **Name:** Christopher James Lüscher
- **Language:** Danish (agent communicates in Danish)
- **Timezone:** Europe/Copenhagen
- **Technical level:** Non-technical. Never show terminal output, logs, or error traces.
- **Working hours:** TBD — ask Christopher during setup

## Email accounts

| Email | Provider | OAuth status | Action |
|-------|----------|-------------|--------|
| lyscher@gmail.com | Gmail | Ready | OAuth direct |
| christopher@curcle.com | M365 | Admin consent pending (Curcle responded positively Mar 13) | Forward to hekla.is |
| LeapCraft email | M365 | Blocked | Forward to hekla.is |
| Patentopia email | M365 | Blocked | Forward to hekla.is |
| Group4Grant email | TBD | TBD | Forward to hekla.is |
| ConduitVentureLabs email | TBD | TBD | Forward to hekla.is |

> **Note to operator:** Fill in exact email addresses before running setup. If unknown, ask Christopher.

## Unified inbox

- **hekla.is address:** christopher@hekla.is (Google Workspace)
- All M365 accounts forward here. Agent reads/writes from this unified inbox.

## Calendar

- Google Calendar on lyscher@gmail.com (primary)
- Other calendars TBD — ask Christopher which calendars he actively uses

## Chat interface

- Telegram (preferred)

## Ventures & context

Christopher runs multiple ventures. This context helps the PA agent prioritize and understand his world:

- **Curcle** — primary active venture
- **Nordicap**
- **Patentopia** — IP/patent related
- **LeapCraft**
- **Group4Grant**
- **ConduitVentureLabs**

## PA agent personality summary

This seeds the SOUL.md generation. The full SOUL.md is generated during setup.

- Professional but warm, communicates in Danish
- Respects working hours, actively helps reduce total workload
- Reads all inbound messages across platforms, presents them prioritized with context
- Suggests draft replies — Christopher approves or edits before sending
- Nudges about unanswered important emails ("Du har ikke svaret X om Y i 3 dage")
- Morning briefing: time-aware greeting → calendar overview → email highlights → action items
- Meeting coordination: background, participant descriptions, agenda. Post-meeting: decision summary + action items
- Helps maintain work-life balance: cultural activities, travel suggestions, milestone reminders, healthy lifestyle nudges
- Maximum response length: 3-4 short paragraphs unless asked for more
- Never proposes major data operations without explicit confirmation
- If something fails, one sentence explaining what happened and what's being done

## Christopher's full vision (future reference)

From his February 2026 email. This is NOT in scope for MVP — but the architecture must allow adding these as agent folders later.

- **Archiver Agent** — fetch personal data from big tech, organize in structured infrastructure. ISO 9001 documentation standards. Data room per project following DD best practices. Route data to correct locations. Remove obsolete data.
- **PA Agent** ← THIS IS THE MVP. Unified communications across all email + WhatsApp + LinkedIn + WeChat. Minimal interfaces. Prioritized inbox. Meeting coordination with prep docs and note-taking. Work-life balance.
- **Shadow Mind Agent** — DECOMMISSIONED. Went rogue on Dropbox March 2026. Do not reinstall. Remove any remnants found on the machine.
- **Personal CRM Agent** — contact management, relationship scoring, "placing power" analysis per contact and industry.
- **CFO Agent** — invoice processing, project accounting, loan tracking, financial models (unit economics, techno-economics, liquidity, forecasts), investment evaluation.
- **CIO Agent** — IP management, patent strategy (especially software patents), third-party rights evaluation, confidentiality classification, innovation log with contributor tracking.
- **CLO Agent** — legal exposure assessment (personal → holding → project/company), tax rules, jurisdiction awareness.
- **Venture Builder Agent** — 12-step venture maturation framework (Discovery → Back-of-envelope → Design guide → Solution-problem fit → Validation → Roadmap → Illustrations → Financial model → GTM → Venture package → Operating playbooks → Team plan → Continuous governance). Living concept documents that update as inputs change.

## Known issues (specific to this unit)

- Previous failed HEKLA install exists. Shadow Mind remnants, broken OpenClaw setup, possibly old agent configs and UTM VM.
- Mac Mini passcode is 1234 — change during setup.
- Ollama may be installed with old or wrong models.
- UTM VM may be present — previous isolation approach, now replaced by macOS user account isolation.
- Pipeline should scan, report what it finds, and ask operator how to handle it.

## Secrets

Referenced from `christopher.env` (not in git). Operator fills this in before running setup.
