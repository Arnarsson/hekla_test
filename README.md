# HEKLA - Local AI Personal Assistant System

A privacy-first, on-premise AI personal assistant system using Docker Compose, Ollama, and a multi-agent architecture.

## Architecture Overview

HEKLA is designed to run entirely locally on customer hardware, with optional cloud overflow for complex tasks.

### Core Stack
- **Ollama** - Local LLM inference (OpenAI-compatible API)
- **PostgreSQL** - Memory/state persistence
- **Redis** - Job queue for agent coordination
- **Langfuse** - Self-hosted observability
- **Electron** - Desktop app for OAuth + dashboard

### Agent System
- **Orchestrator** - Routes tasks to specialized agents
- **Mail Agent** - Microsoft Graph integration for email
- **Calendar Agent** - Schedule management and event creation
- **Memory Agent** - Long-term context storage

### Hardware Tiers
| Tier | VRAM | Model | Use Case |
|------|------|-------|----------|
| Personal | 16-24GB | qwen2.5:14b | Basic PA tasks |
| High Performance | 36-64GB | qwen2.5:32b / llama3.3:70b | Full capability |

---

## Phased Build Plan

### Phase 0 - Foundation (Weeks 1-2)
**Goal:** Reproducible local dev environment

- Docker Compose stack with GPU passthrough
- Ollama container with NVIDIA Container Toolkit
- PostgreSQL + Redis for state/queue
- Basic REST gateway
- **Deliverable:** Any team member can `docker compose up` and hit the inference API

### Phase 1 - Agent Core (Weeks 3-5)
**Goal:** Multi-agent system with job queue

- Deploy agents as isolated containers
- Redis-based task queue (bullmq)
- Supervisor pattern for task routing
- Agent-to-agent communication contracts
- Langfuse observability
- **Deliverable:** PA agent routes to Mail/Calendar agents locally

### Phase 2 - Integrations (Weeks 6-9)
**Goal:** Mail + Calendar working with real client data

- OAuth flow in Electron app
- Microsoft Graph API integration
- Telegram bot as primary interface
- Forward-mail fallback path
- **Deliverable:** User asks "what's in my inbox?" via Telegram, gets local inference response

### Phase 3 - Onboarding (Weeks 10-13)
**Goal:** Non-technical customer onboarding in <30 min

- Setup Assistant Agent (interactive CLI wizard)
- Electron desktop dashboard
- Automated smoke tests
- Ship runbook for 20 units
- **Deliverable:** Spring 2026 limited drop ready

### Phase 4 - Hardening (Post-launch)
**Goal:** Tier differentiation + subscription revenue

- OpenRouter fallback for complex tasks
- Model hot-swap capability
- Subscription add-ons (mail forwarding, calendar sync, cloud overflow)

---

## Quick Start

```bash
# 1. Copy environment template
cp .env.example .env

# 2. Run setup script (detects GPU, pulls model, configures)
./scripts/setup.sh

# 3. Start the stack
docker compose up -d

# 4. Verify everything works
node scripts/qa.js
```

## Project Structure

```
hekla/
├── docker-compose.yml      # Full stack definition
├── .env.example            # Environment template
├── services/
│   ├── gateway/            # API router
│   ├── agents/
│   │   ├── orchestrator/   # Task routing
│   │   ├── mail/           # Microsoft Graph mail
│   │   ├── calendar/       # Calendar management
│   │   └── memory/         # Long-term context
│   └── langfuse/           # Observability config
├── electron-app/           # Desktop dashboard
├── postgres/
│   └── init.sql            # Database schema
├── scripts/
│   ├── setup.sh            # First-boot setup
│   └── qa.js               # Automated tests
└── models/                 # Ollama model storage
```

## Risk Flags

1. **16GB Personal tier** - May show lag under load. Consider 24GB minimum for demos.
2. **Setup experience** - The onboarding agent (Phase 3) is where HEKLA earns trust.
3. **OAuth scalability** - Each corporate client has different Azure/Entra admin. Need self-serve consent flow.
4. **Observability** - Ship Langfuse in Phase 1, not as an afterthought.

---

## Links

- [Slack Thread](https://hekla-workspace.slack.com/archives/C0ALNUB1EEP/p1773739480477879?thread_ts=1773738407.815499&cid=C0ALNUB1EEP)
