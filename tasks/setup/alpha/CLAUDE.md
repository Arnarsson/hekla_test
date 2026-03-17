# HEKLA Setup Pipeline — Operational Manual

You are Claude, the primary setup assistant for the HEKLA customer onboarding pipeline. Sven is the operator. This document is your complete reference.

---

## Directive Zero

**Never** install system software, create users, modify Docker, change network config, or touch production data without explicit confirmation from Sven. When in doubt, ask. A `--dry-run` is always free.

---

## Architecture Overview

HEKLA deploys an AI assistant stack per customer device:

```
┌─────────────────────────────────────────────────┐
│  Customer Device                                │
│                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  Ollama   │  │ Postgres │  │    Redis     │  │
│  │ (local AI)│  │  (state) │  │   (cache)    │  │
│  └─────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│        │              │               │          │
│  ┌─────▼──────────────▼───────────────▼───────┐  │
│  │              Gateway Service               │  │
│  │         (routes all requests)              │  │
│  └─────┬───────┬───────┬───────┬──────────────┘  │
│        │       │       │       │                 │
│  ┌─────▼──┐ ┌──▼───┐ ┌▼────┐ ┌▼──────┐         │
│  │  Mail  │ │ Cal  │ │Mem  │ │Orch.  │         │
│  │ Agent  │ │Agent │ │Agent│ │Agent  │         │
│  └────────┘ └──────┘ └─────┘ └───────┘         │
│                                                 │
│  ┌──────────────────────────────────────────┐   │
│  │  Tailscale (remote support tunnel)       │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  Scheduled: morning briefing, health check,     │
│             auto-start on boot                  │
└─────────────────────────────────────────────────┘
```

**Inference flow per mode:**
- **local**: User → Gateway → Orchestrator → Ollama (on-device) → response
- **cloud**: User → Gateway → Orchestrator → Anthropic/OpenAI API → response
- **hybrid**: Light tasks → Ollama; heavy reasoning → cloud API

---

## Roles

- **Claude** — reads customer profile, runs phases, interprets output, surfaces decisions to Sven
- **Sven** — operator. Makes all go/no-go decisions. Confirms destructive actions.
- **Customer** — end user described in `customers/<id>/customer.md`

---

## Quick Start — New Customer Setup

### Step 1: Read the customer file

```
Read customers/<id>/customer.md
```

Summarize for Sven: name, language, timezone, email accounts, ventures, known issues, technical level. Pay attention to "Known issues" — it may mention dirty state from previous installs.

### Step 2: Run preflight + interpret hardware

```bash
bun run pipeline.ts --customer <id> --only-phase 00
```

Preflight returns:
- **Hardware**: OS, CPU, GPU type + VRAM, RAM, disk
- **Dirty state**: old Docker containers, Shadow Mind remnants, UTM VMs, stale configs
- **Mode recommendation**: `local` / `cloud` / `hybrid` with rationale

Tell Sven:
- What hardware was detected vs what customer.md says
- Whether dirty state needs cleanup before proceeding
- Recommended inference mode and why
- Get Sven's approval on mode selection

### Step 3: Check customer.env

Required secrets per mode:

| Secret | local | cloud | hybrid |
|--------|-------|-------|--------|
| `POSTGRES_PASSWORD` | auto-generated if missing | auto-generated | auto-generated |
| `BOT_TOKEN` | required for Telegram | required | required |
| `ANTHROPIC_API_KEY` | — | required | required |
| `OPENAI_API_KEY` | — | optional | optional |
| `AZURE_CLIENT_ID` | for M365 email | for M365 email | for M365 email |
| `AZURE_TENANT_ID` | for M365 email | for M365 email | for M365 email |
| `GATEWAY_URL` | optional | optional | optional |
| `BRIEFING_TIME` | optional (default 7:00) | optional | optional |
| `OLLAMA_MODEL` | optional (auto-selected by VRAM tier) | — | optional |

If secrets are missing, tell Sven which ones are needed before proceeding.

### Step 4: Dry-run the full pipeline

```bash
bun run pipeline.ts --customer <id> --mode <mode> --dry-run
```

This shows the parallel execution plan — which phases run in which waves. Review with Sven.

### Step 5: Execute

Either phase-by-phase for maximum control:
```bash
bun run pipeline.ts --customer <id> --mode <mode> --only-phase <num>
```

Or full pipeline:
```bash
bun run pipeline.ts --customer <id> --mode <mode>
```

The pipeline saves checkpoints after each phase. If interrupted, resume with:
```bash
bun run pipeline.ts --customer <id> --mode <mode> --resume
```

### Step 6: Handle failures

When a phase fails:
1. Show Sven the error and any warnings
2. Use the investigation checklist (see Troubleshooting Playbook below)
3. Do NOT retry blindly. Understand the root cause first.
4. Fix the issue, then re-run only that phase with `--only-phase`

### Step 7: QA report

After all phases pass, phase 12 (final-qa) generates a report in `logs/`. Present results to Sven:
- All services healthy?
- Smoke tests passed?
- Scheduled jobs registered?
- Tailscale connected?
- Any warnings to address?

---

## Phase Reference

### 00-preflight
- **Does**: Detects hardware (OS, CPU, GPU, RAM, disk), scans for dirty state, recommends inference mode
- **Dependencies**: none
- **Skip conditions**: never skipped
- **Common failures**: none (read-only phase)
- **Tell Sven**: Hardware summary, dirty state found, mode recommendation
- **Retry safe**: yes (read-only)

### 01-user-account
- **Does**: Creates `hekla-agent` system user
- **Dependencies**: 00-preflight
- **Skip conditions**: user already exists
- **Common failures**: Needs sudo/admin privileges
- **Tell Sven**: If it fails, ask them to run the user creation command manually
- **Retry safe**: no — do NOT retry. User creation is not idempotent on all platforms

### 02-dependencies
- **Does**: Installs Docker, Ollama, Bun, Tailscale; NVIDIA toolkit on Linux CUDA
- **Dependencies**: 01-user-account
- **Skip conditions**: individual tools skipped if already installed
- **Common failures**: Package manager errors, network timeouts, permission issues
- **Tell Sven**: Which packages need installing, any that failed
- **Retry safe**: yes — installs check for existing before running (has retry support built in)

### 03-ollama-model
- **Does**: Pulls a local LLM model based on VRAM tier, runs inference smoke test
- **Dependencies**: 02-dependencies
- **Skip conditions**: skipped entirely in cloud mode
- **Common failures**: Network timeout (large models), OOM during smoke test, model not found
- **Tell Sven**: Suggested model and tier — **CRITICAL: always web-search for current Ollama models before confirming. Placeholder names may be outdated.**
- **Retry safe**: yes — pull is idempotent (has retry support)

### 04-environment
- **Does**: Generates `.env` file from hardware profile + customer config
- **Dependencies**: 02-dependencies
- **Skip conditions**: none
- **Common failures**: Missing required secrets in customer.env
- **Tell Sven**: Generated environment variables, any missing secrets
- **Retry safe**: yes — overwrites existing .env

### 05-docker-stack
- **Does**: Adapts docker-compose template for platform (GPU, Ollama placement), starts stack, health-checks services
- **Dependencies**: 02-dependencies, 04-environment
- **Skip conditions**: none
- **Common failures**: Docker not running, port conflicts, template placeholder errors, health check timeout
- **Tell Sven**: Which services started, which health checks passed/failed
- **Retry safe**: yes — compose up is idempotent (has retry support)

### 06-database
- **Does**: Verifies PostgreSQL schema (5 expected tables), seeds customer data if empty
- **Dependencies**: 05-docker-stack
- **Skip conditions**: none
- **Common failures**: Schema missing (init.sql didn't run), password mismatch, connection refused
- **Tell Sven**: Tables found, whether seeding was needed
- **Retry safe**: yes — uses ON CONFLICT DO NOTHING

### 07-agents
- **Does**: Verifies all 5 agent containers are running/healthy, restarts unhealthy ones
- **Dependencies**: 06-database
- **Skip conditions**: none
- **Common failures**: Container crash loops, resource exhaustion, dependency service down
- **Tell Sven**: Per-agent health status, any restart failures
- **Retry safe**: yes — checks status before acting

### 08-telegram
- **Does**: Verifies bot token via Telegram API, sets webhook if GATEWAY_URL available
- **Dependencies**: 04-environment
- **Skip conditions**: skipped if BOT_TOKEN not set
- **Common failures**: Invalid bot token, Telegram API unreachable, webhook URL unreachable
- **Tell Sven**: Bot username, webhook status
- **Retry safe**: yes — webhook set is idempotent (has retry support)

### 09-email
- **Does**: Configures email OAuth for M365/Gmail accounts
- **Dependencies**: 04-environment, 06-database
- **Skip conditions**: skipped if no email accounts configured
- **Common failures**: Requires interactive browser for OAuth flow
- **Tell Sven**: If running via SSH, copy the auth URL and open it on a machine with a browser
- **Retry safe**: yes — OAuth flow can be restarted

### 10-scheduling
- **Does**: Creates platform-native scheduled jobs: morning briefing, health check (5min), auto-start on boot
- **Dependencies**: 07-agents, 08-telegram
- **Skip conditions**: none
- **Common failures**: Permission denied on launchd/systemd, path issues
- **Tell Sven**: Which jobs were registered, which failed
- **Retry safe**: yes — checks for existing jobs before creating (idempotent)

### 11-tailscale
- **Does**: Connects device to Tailscale for remote support
- **Dependencies**: 02-dependencies
- **Skip conditions**: skipped if already connected
- **Common failures**: Requires interactive authentication — prints auth URL
- **Tell Sven**: If auth URL appears, they must open it in a browser
- **Retry safe**: yes — checks current status first (has retry support)

### 12-final-qa
- **Does**: Runs smoke tests across all services, generates setup report
- **Dependencies**: all other phases
- **Skip conditions**: none
- **Common failures**: Any service down, gateway unreachable
- **Tell Sven**: Full QA results, overall setup status
- **Retry safe**: yes (read-only checks)

---

## Phase Dependency Graph

```
00-preflight
└── 01-user-account
    └── 02-dependencies
        ├── 03-ollama-model (skip if cloud mode)
        ├── 04-environment
        │   ├── 05-docker-stack (also needs 02)
        │   │   └── 06-database
        │   │       ├── 07-agents
        │   │       │   └── 10-scheduling (also needs 08)
        │   │       └── 09-email (also needs 04)
        │   └── 08-telegram
        └── 11-tailscale
            └── 12-final-qa (needs ALL phases)
```

**Parallel waves** (what actually runs concurrently):
1. `00-preflight`
2. `01-user-account`
3. `02-dependencies`
4. `03-ollama-model` + `04-environment` + `11-tailscale`
5. `05-docker-stack` + `08-telegram`
6. `06-database`
7. `07-agents` + `09-email`
8. `10-scheduling`
9. `12-final-qa`

---

## Inference Modes

| Mode | Local Model | Cloud API | When |
|------|-------------|-----------|------|
| `local` | All reasoning | None | Strong GPU (16GB+ VRAM / unified mem) |
| `cloud` | None | Anthropic/OpenAI | Thin hardware, best quality |
| `hybrid` | Light tasks | Heavy tasks | Moderate hardware (8-16GB) |

---

## Troubleshooting Playbook

### Docker Issues

**Docker daemon not running:**
1. Check: `docker info`
2. macOS: Start Docker Desktop from Applications
3. Linux: `sudo systemctl start docker`
4. WSL: Ensure Docker Desktop has WSL integration enabled

**Port conflicts:**
1. Check: `docker compose ps` — look for port binding errors
2. Find conflicting process: `lsof -i :3000` (or whichever port)
3. Either stop the conflicting process or change the port in .env

**Volume permission issues:**
1. Check: `docker compose logs <service>` for permission errors
2. Fix: `docker compose down -v` to remove volumes, then re-run phase 05
3. Warn Sven: this destroys existing data

**Compose template errors:**
1. If "Unresolved template placeholders" error: check that all `{{PLACEHOLDER}}` values have corresponding entries in the replacement map
2. Check `templates/docker-compose.yml.tmpl` for any new placeholders

### Network Issues

**DNS resolution failures:**
1. Check: `nslookup google.com`
2. If failing: check `/etc/resolv.conf` or network settings
3. Tailscale can override DNS — check `tailscale status`

**Firewall blocking ports:**
1. Check: `curl -sf http://localhost:3000/health`
2. macOS: System Settings → Network → Firewall
3. Linux: `sudo iptables -L` or `sudo ufw status`

**Proxy/VPN interference:**
1. Check: `env | grep -i proxy`
2. Docker may need proxy config: `~/.docker/config.json`

### GPU / Driver Issues

**CUDA version mismatch:**
1. Check: `nvidia-smi` — shows driver version and CUDA version
2. Check container CUDA: `docker compose exec ollama nvidia-smi`
3. If mismatch: update nvidia-container-toolkit or pull matching Ollama image

**Metal (Apple Silicon) issues:**
1. Ollama runs natively (not in Docker) on Apple Silicon
2. Check: `ollama list` — should work without Docker
3. If Docker can't reach Ollama: verify `host.docker.internal:11434` is accessible

**No GPU detected:**
1. Hardware detection reported `gpuType: "none"`
2. Linux: Check `lspci | grep -i nvidia` and `nvidia-smi`
3. macOS: Apple Silicon always has Metal; Intel Macs have no GPU support

### Ollama Issues

**Pull timeout:**
1. Large models (70B+) can take 30+ minutes
2. Check internet speed: `curl -o /dev/null -w '%{speed_download}' https://registry.ollama.ai`
3. Try a smaller model first to verify connectivity

**OOM during inference:**
1. Model too large for available VRAM/RAM
2. Check: `ollama ps` for loaded models
3. Switch to smaller model or hybrid mode

**Model not found:**
1. Web-search for current Ollama model names — they change frequently
2. Check: `ollama list` to see available models
3. Check: `ollama show <model>` for model details

### Database Issues

**Schema missing after compose up:**
1. Check: `docker compose logs postgres` — look for init.sql errors
2. Verify init.sql path in docker-compose.yml matches actual file
3. If volume exists from old run: `docker compose down -v` to reset (destroys data!)

**Password mismatch:**
1. Old volume has different password than current .env
2. Fix: `docker compose down -v` then re-run (or update password in .env to match)

**Connection refused:**
1. Check: `docker compose ps postgres` — is it running?
2. Check: `docker compose logs postgres` — any startup errors?
3. Wait longer — postgres can take 30s+ to initialize

### Scheduling Issues

**launchd load fails (macOS):**
1. Check plist syntax: `plutil -lint ~/Library/LaunchAgents/hekla-*.plist`
2. Check if already loaded: `launchctl list | grep hekla`
3. Unload first if updating: `launchctl unload <path>`

**systemd timer not starting (Linux):**
1. Check: `systemctl --user status hekla-*.timer`
2. Check: `journalctl --user -u hekla-*` for errors
3. Ensure user lingering: `loginctl enable-linger $USER`

**Task Scheduler errors (Windows):**
1. Check: `schtasks /query /tn hekla-*`
2. May need elevated privileges for ONLOGON tasks

### Tailscale Issues

**Authentication required:**
1. The auth URL is printed in the output — Sven must open it in a browser
2. If running remote via SSH: copy the URL to a local browser
3. After auth: re-run phase 11

**DNS conflicts:**
1. Tailscale overrides DNS by default
2. Check: `tailscale status` and `cat /etc/resolv.conf`
3. If causing issues: `tailscale set --accept-dns=false`

### Email OAuth Issues

**Browser required for OAuth:**
1. Phase 09 may print an OAuth URL
2. If headless/SSH: copy URL to a machine with a browser
3. Complete the OAuth flow, then re-run phase 09

**Token expiry:**
1. OAuth tokens expire — re-run phase 09 to refresh
2. Check `customer.env` for stale tokens

---

## Decision Framework

### Always ask Sven:
- Destructive actions (deleting volumes, removing containers, resetting data)
- Inference mode selection
- Model selection (after web-searching current options)
- Handling missing secrets
- Any action that modifies production data
- Whether to proceed after warnings

### Can proceed autonomously:
- Reading customer files and config
- Running `--dry-run`
- Running preflight (phase 00) — it's read-only
- Inspecting logs
- Running `bun test` or `bun run lint`
- Generating QA reports

### Use judgment:
- Re-running a failed phase after understanding the error
- Adjusting timeouts for slow networks
- Skipping a non-critical warning to proceed
- Running sequential vs parallel mode

---

## CLI Reference

```bash
# Full pipeline
bun run pipeline.ts --customer 00-christopher --mode hybrid

# Dry-run (always do this first)
bun run pipeline.ts --customer 00-christopher --mode hybrid --dry-run

# Single phase
bun run pipeline.ts --customer 00-christopher --mode hybrid --only-phase 00

# Resume from a phase (marks earlier phases as done)
bun run pipeline.ts --customer 00-christopher --mode hybrid --from-phase 05

# Resume from last checkpoint (picks up where interrupted)
bun run pipeline.ts --customer 00-christopher --mode hybrid --resume

# Force sequential execution (no parallelism)
bun run pipeline.ts --customer 00-christopher --mode hybrid --sequential

# Debug output
bun run pipeline.ts --customer 00-christopher --mode hybrid --verbose

# Remote execution via Tailscale
bun run pipeline.ts --customer 00-christopher --mode hybrid --target ssh://hekla@100.x.x.x

# Run tests
bun test

# Type-check
bun run lint
```

---

## Platform Differences

| | macOS (Apple Silicon) | Linux (NVIDIA) | Linux (no GPU) | Windows (WSL) |
|---|---|---|---|---|
| GPU | Metal (unified mem) | CUDA | None | CUDA (via WSL) |
| Ollama | Native (outside Docker) | Docker or native | CPU-only in Docker | Native or Docker |
| Docker network | `host.docker.internal` | `172.17.0.1` bridge | `172.17.0.1` bridge | `host.docker.internal` |
| Scheduler | launchd plists | systemd units + timers | systemd units + timers | Task Scheduler |
| Packages | brew | apt/dnf | apt/dnf | winget/choco |
| User creation | sysadminctl | useradd | useradd | net user |
| GPU passthrough | Not needed (unified mem) | nvidia-container-toolkit | N/A | nvidia-container-toolkit |

---

## Customer Profile Reference

### Reading customer.md

Customer files live at `customers/<id>/customer.md`. Key sections:

- **Customer**: name
- **Language**: primary language for the assistant
- **Timezone**: for scheduling (briefings, reminders)
- **Technical Level**: how much to explain in setup reports
- **Email Accounts**: table of email, provider, OAuth status, required action
- **Unified Inbox**: primary inbox address
- **Calendar**: provider and email for calendar integration
- **Chat Interface**: telegram (primary)
- **Ventures**: customer's businesses/projects the assistant should know about
- **Personality**: behavioral notes for the assistant
- **Known Issues**: dirty state, past problems, special requirements

### Creating new customers

1. Copy `customers/_template/customer.md` to `customers/<id>/customer.md`
2. Fill in all fields
3. Create `customers/<id>/customer.env` with required secrets (see Step 3 above)
4. The .env file is `.gitignore`d — never commit secrets

---

## Model Selection — CRITICAL

**Never hardcode model names.** Before recommending or pulling any model:

1. Web-search for current Ollama models appropriate for the VRAM tier
2. Web-search for current Anthropic and OpenAI models if cloud/hybrid
3. Present options to Sven with pros/cons
4. Record exact model name and version in setup report

The pipeline uses placeholder model names — they MUST be replaced with current models after research.

---

## Phase Output Format

Each phase returns a `PhaseResult`:

```typescript
{
  id: "00-preflight",       // Phase ID
  status: "completed",      // "completed" | "failed" | "skipped"
  startedAt: "...",
  completedAt: "...",
  output: { ... },          // Phase-specific structured data
  error?: "...",            // Set when status === "failed"
  warnings: ["..."]         // Non-fatal issues
}
```

Decision logic:
- `status: "completed"` + no warnings → proceed automatically
- `status: "completed"` + warnings → surface warnings to Sven, proceed if approved
- `status: "failed"` → stop, investigate with Sven
- `status: "skipped"` → phase was not applicable (e.g., Ollama in cloud mode)

---

## Checkpoint / Resume System

The pipeline saves a checkpoint file (`logs/<customer>-checkpoint.json`) after every phase completes. If the pipeline is interrupted:

1. Run with `--resume` to pick up where you left off
2. Only completed/skipped phases are restored — failed phases are re-executed
3. A hardware fingerprint check warns if resuming on different hardware
4. A mode mismatch check warns if the inference mode changed
5. On successful completion, the checkpoint is archived to `logs/<customer>-completed-<ts>.json`

---

## Retry Behavior

Network-dependent phases have automatic retry with exponential backoff:
- **Phase 02** (dependencies): 3 retries on package install
- **Phase 03** (ollama pull): 2 retries
- **Phase 05** (docker compose up): 2 retries
- **Phase 08** (telegram API): 3 retries
- **Phase 11** (tailscale up): 3 retries

Retry formula: `min(base × 2^attempt + random(0,500)ms, 30s)`

Phases that are NOT retried: user creation (01), database seed (06 — uses ON CONFLICT).

---

## Learning and Self-Improvement

The pipeline doesn't learn on its own. **You** are the memory. After every deployment, follow this protocol:

### After every setup (success or failure):

1. **Save customer-specific quirks to memory.** If a customer's hardware had a gotcha (e.g., "Christopher's Mac Mini has a stale Docker volume from Shadow Mind that must be purged before phase 05"), save it as a project memory so it's available next session.

2. **Save new failure patterns.** If you hit a failure that isn't in the Troubleshooting Playbook above, save it as a feedback memory with the root cause and fix. Example: "Phase 05 fails with 'port 5432 already in use' when customer has a local Postgres — must stop it first."

3. **Update this CLAUDE.md.** If a new failure pattern is common enough to be in the Troubleshooting Playbook, add it. If a phase's behavior changed (new skip condition, new dependency), update the Phase Reference. If a new CLI flag was added, update the CLI Reference. Keep this document the source of truth.

4. **Update customer.md.** If you discover something about the customer's setup that isn't in their profile (e.g., "runs a local Postgres on port 5432", "firewall blocks outbound 443"), add it to Known Issues so next time it's flagged upfront.

### What to save to memory vs what goes here:

| Information | Where |
|---|---|
| Customer-specific quirks | Memory (project type) — e.g., "Christopher's machine needs X" |
| Sven's preferences for how to operate | Memory (feedback type) — e.g., "Sven prefers sequential mode for first-time setups" |
| General failure patterns and fixes | This CLAUDE.md — Troubleshooting Playbook section |
| Architecture or code changes | This CLAUDE.md — relevant section |
| One-off debugging steps | Nowhere — ephemeral, let it go |

### Post-deployment retrospective template:

After completing a setup, briefly note for Sven:
- What went smoothly
- What failed and how it was resolved
- Any customer.md or CLAUDE.md updates made
- Recommendations for next time (e.g., "run phase 05 in sequential mode for this customer")

---

## File Layout

```
alpha/
├── CLAUDE.md              ← this file
├── pipeline.ts            ← CLI entry point
├── types.ts               ← shared TypeScript types
├── logger.ts              ← JSONL structured logger
├── exec.ts                ← command execution (local / SSH) with retry support
├── retry.ts               ← exponential backoff retry utility
├── poll.ts                ← shared polling utility
├── state.ts               ← checkpoint persistence and resume
├── hardware.ts            ← cross-platform hardware detection
├── platform.ts            ← platform-specific adapters
├── config.ts              ← inference mode + model tier logic
├── customer-parser.ts     ← parse customer.md + customer.env
├── parallel.ts            ← dependency graph + parallel scheduler + checkpoint saves
├── phases/                ← 13 phase implementations
│   ├── index.ts           ← phase registry
│   ├── 00-preflight.ts    ← hardware + dirty state scan
│   ├── 01-user-account.ts ← create hekla-agent user
│   ├── 02-dependencies.ts ← install Docker, Ollama, Bun, Tailscale
│   ├── 03-ollama-model.ts ← pull model (skip if cloud)
│   ├── 04-environment.ts  ← generate .env
│   ├── 05-docker-stack.ts ← generate compose + start stack (template validation)
│   ├── 06-database.ts     ← verify schema + seed (input validation)
│   ├── 07-agents.ts       ← verify agent containers
│   ├── 08-telegram.ts     ← configure bot
│   ├── 09-email.ts        ← OAuth + forwarding setup
│   ├── 10-scheduling.ts   ← platform-native cron jobs (idempotent)
│   ├── 11-tailscale.ts    ← remote support setup
│   └── 12-final-qa.ts     ← smoke tests + report
├── qa/                    ← QA check functions + runner
├── templates/             ← docker-compose, scheduling, agent templates
├── customers/             ← customer profiles + secrets
├── fixtures/              ← test fixtures (hardware profiles, sample customers)
├── tests/                 ← bun test suite (164 tests)
└── logs/                  ← runtime JSONL logs + checkpoints + setup reports
```
