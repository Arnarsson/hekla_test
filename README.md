# HEKLA — Local AI Personal Assistant

A privacy-first, on-premise AI personal assistant running on Mac Mini M4.
Customers order the device, we set it up, ship it ready to go.

**https://www.hekla.cc/**

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Mac Mini M4 (Apple Silicon)                     │
│                                                  │
│  ┌──────────────────────────────────────┐        │
│  │  Ollama (native macOS — Metal GPU)   │        │
│  │  :11434                              │        │
│  └──────────────┬───────────────────────┘        │
│                 │ host.docker.internal            │
│  ┌──────────────▼───────────────────────┐        │
│  │  Docker                              │        │
│  │  ┌─────────┐ ┌──────────────────┐    │        │
│  │  │ Gateway │→│  Orchestrator    │    │        │
│  │  │ :3000   │ │  :3010           │    │        │
│  │  └─────────┘ └──┬───┬───┬──────┘    │        │
│  │                  │   │   │           │        │
│  │        ┌─────────┘   │   └────────┐  │        │
│  │        ▼             ▼            ▼  │        │
│  │  ┌──────────┐ ┌──────────┐ ┌───────┐│        │
│  │  │Mail Agent│ │Cal Agent │ │Memory ││        │
│  │  │(isolated)│ │(isolated)│ │Agent  ││        │
│  │  └──────────┘ └──────────┘ └───────┘│        │
│  │                                      │        │
│  │  ┌──────────┐ ┌──────────┐           │        │
│  │  │PostgreSQL│ │  Redis   │           │        │
│  │  │(state)   │ │ (queue)  │           │        │
│  │  └──────────┘ └──────────┘           │        │
│  │  ┌──────────┐                        │        │
│  │  │ Langfuse │  (observability)       │        │
│  │  └──────────┘                        │        │
│  └──────────────────────────────────────┘        │
│                                                  │
│  ┌──────────────────────────────────────┐        │
│  │  Electron App (OAuth + Dashboard)    │        │
│  └──────────────────────────────────────┘        │
└──────────────────────────────────────────────────┘
```

### Why this design?

- **Ollama runs natively** on macOS — Docker cannot pass through Apple's Metal GPU. Native = full Apple Silicon acceleration.
- **Each agent is an isolated Docker container** — if one goes rogue or dies, nothing else breaks. `restart: unless-stopped` brings it back.
- **Queue for collaboration, no parallelism** — agents process jobs serially via Redis/BullMQ. One LLM call at a time. No resource contention.
- **Electron app** for OAuth flow and simple management dashboard.
- **Telegram** as the primary user interface for communicating with agents.

### Core Stack
- **Ollama** — Local LLM inference (native macOS, Metal acceleration)
- **PostgreSQL** — Memory/state persistence
- **Redis + BullMQ** — Serial job queue for agent coordination
- **Langfuse** — Self-hosted observability and tracing
- **Electron** — Desktop app for OAuth + dashboard

---

## Hardware Tiers (Mac Mini M4)

| Tier | Unified Memory | Model | Docker | Performance |
|------|---------------|-------|--------|-------------|
| **Base** | 16GB (M4) | qwen2.5:7b | `docker compose up -d` | Core PA tasks, fast responses |
| **Base+** | 24GB | qwen2.5:14b | `docker compose up -d` | Better reasoning |
| **Pro** | 36GB (M4 Pro) | qwen2.5:32b | `docker compose --profile full up -d` | Full capability, optimal |
| **Max** | 64–128GB (M4 Max) | llama3.3:70b | `docker compose --profile full up -d` | Near-SOTA local inference |

> The base M4 Mac Mini (16GB) works well — `qwen2.5:7b` fits comfortably with all Docker services.
> Langfuse observability is enabled via `--profile full` on 36GB+ machines to save RAM on base tier.
> The Pro tier (36GB) is the sweet spot for full capability.

---

## Quick Start

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Run setup (detects hardware, picks model, starts stack)
./scripts/setup.sh

# 3. Run QA tests
node scripts/qa.js

# 4. Preview stack health (no Docker required)
./scripts/preview.sh
```

> On the base M4 Mac Mini (16GB), setup automatically picks `qwen2.5:7b` and skips Langfuse to save RAM.
> On 36GB+ machines, it picks a larger model and enables full observability.

---

## How It Works

1. **Customer orders** a Mac Mini M4 (configured to their tier)
2. **We set it up** via the setup assistant agent — mega-prompts, tests, Docker
3. **Ship it** ready to go
4. **Customer opens** the Electron app, does OAuth, connects Telegram
5. **They talk to HEKLA** via Telegram: "What's in my inbox?", "Block 2pm for focus time"

### Agent System
- **Orchestrator** — Classifies intent, routes to the right agent
- **Mail Agent** — Microsoft Graph integration, email triage/summary
- **Calendar Agent** — Schedule management, event creation
- **Memory Agent** — Long-term context, preferences, recall

### Communication Flow
```
User (Telegram) → Gateway → Orchestrator → [Mail|Calendar|Memory] Agent
                                                    ↓
                                              Ollama (Metal GPU)
                                                    ↓
                                              Response → User
```

Jobs are queued serially — no parallel LLM calls, no resource contention.

---

## Alternative Solutions (Phase 4 — Subscription)

For customers who can't or won't do full OAuth:

| Solution | Description |
|----------|-------------|
| **Mail forwarding** | Forward emails to HEKLA instead of OAuth |
| **Telegram-only** | All communication through Telegram bot |
| **OpenRouter overflow** | Route complex tasks to cheaper cloud models |
| **Subscription tiers** | Mail sync, calendar sync, cloud overflow add-ons |

---

## Phased Build Plan

### Phase 0 — Foundation
- Docker Compose stack (no K8s)
- Ollama native on macOS with Metal
- PostgreSQL + Redis for state/queue
- Basic REST gateway
- **Ship:** `./scripts/setup.sh` → working inference

### Phase 1 — Agent Core
- Multi-agent system with isolated containers
- Redis-based serial task queue (BullMQ, concurrency: 1)
- Orchestrator routing
- Langfuse observability
- **Ship:** PA routes to Mail/Calendar/Memory agents locally

### Phase 2 — Integrations
- Electron app with OAuth flow
- Microsoft Graph API (mail + calendar)
- Telegram bot as primary interface
- Mail forwarding fallback
- **Ship:** "What's in my inbox?" works via Telegram

### Phase 3 — Onboarding
- Setup Assistant Agent (interactive, tests everything)
- Electron desktop dashboard
- Automated smoke tests + QA suite
- Ship runbook for batch of devices
- **Ship:** Spring 2026 limited drop

### Phase 4 — Hardening
- OpenRouter fallback for complex tasks
- Model hot-swap
- Subscription add-ons
- Goal: near-perfect basic functionality (mail, calendar, communication)

---

## Project Structure

```
hekla/
├── docker-compose.yml          # Agents + infra (no Ollama — runs native)
├── docker-compose.gpu.yml      # Linux/NVIDIA GPU override (optional)
├── .env.example                # Environment template
├── services/
│   ├── gateway/                # API router (Express)
│   └── agents/
│       ├── orchestrator/       # Intent classification + routing
│       ├── mail/               # Microsoft Graph mail agent
│       ├── calendar/           # Calendar management agent
│       └── memory/             # Long-term context agent
├── electron-app/               # Desktop OAuth + dashboard (Phase 2)
├── postgres/
│   └── init.sql                # Database schema
├── scripts/
│   ├── setup.sh                # First-boot setup (macOS)
│   ├── preview.sh              # Pre-flight stack validation
│   └── qa.js                   # Live QA tests
├── tests/
│   └── run-tests.js            # Offline unit tests (45 tests)
└── docs/
    └── SHIP_RUNBOOK.md         # Device shipping checklist
```

---

## Risk Flags

1. **16GB Base tier** — Works well with 7b models. Langfuse auto-disabled to save RAM. Consider 24GB+ for demos.
2. **Onboarding UX** — The setup assistant (Phase 3) is where HEKLA earns customer trust. Must be flawless.
3. **OAuth per-tenant** — Each corporate client has different Azure/Entra admin. Need self-serve consent flow.
4. **Serial queue** — One LLM call at a time means latency under load. Acceptable for single-user device.
5. **Ollama native** — Must ensure `ollama serve` starts on boot (launchd plist or Electron manages it).

---

**https://www.hekla.cc/**
