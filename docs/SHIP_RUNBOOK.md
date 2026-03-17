# HEKLA Ship Runbook — Mac Mini M4

Production checklist for shipping HEKLA devices to customers.

**https://www.hekla.cc/**

---

## Pre-Ship (Our Side)

### Hardware Setup
- [ ] Mac Mini M4 unboxed and powered on
- [ ] Note unified memory: `sysctl -n hw.memsize` (divide by 1073741824 for GB)
- [ ] Assign tier: 16GB = Base, 36GB = Pro, 64GB+ = Max
- [ ] Verify Apple Silicon: `uname -m` should return `arm64`
- [ ] macOS updated to latest stable release

### Software Installation
- [ ] Install Homebrew: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
- [ ] Install Docker Desktop: `brew install --cask docker`
- [ ] Install Ollama: `brew install ollama`
- [ ] Install Node.js: `brew install node`
- [ ] Clone HEKLA: `git clone <repo> ~/hekla`
- [ ] Run setup: `cd ~/hekla && ./scripts/setup.sh`

### Model & Services
- [ ] Verify correct model pulled for tier (check `ollama list`)
- [ ] Ollama responding: `curl http://localhost:11434/api/tags`
- [ ] Docker stack running: `docker compose ps` (all services healthy)
- [ ] Run QA tests: `node scripts/qa.js` (all should pass)
- [ ] Run preview: `./scripts/preview.sh` (0 errors)

### Pre-configuration
- [ ] Set `DEVICE_SERIAL` in .env to unit's serial number
- [ ] Set `DEVICE_TIER` in .env (base / pro / max)
- [ ] Set `DEVICE_NAME` in .env (customer's chosen name)
- [ ] Package Electron app on desktop
- [ ] Configure Ollama to start on boot (launchd plist or Login Items)

### Final Checks
- [ ] Reboot device
- [ ] Verify Ollama auto-starts: `curl http://localhost:11434/api/tags`
- [ ] Verify Docker services auto-start: `docker compose ps`
- [ ] Test inference responds within acceptable latency
- [ ] Langfuse accessible at http://localhost:3001
- [ ] Document any device-specific configuration

---

## Customer Onboarding (Their Side)

### Physical Setup
- [ ] Unbox and connect Mac Mini to power
- [ ] Connect to their network (ethernet recommended for stability)
- [ ] Note device IP address (System Settings → Network)

### Software Setup
- [ ] Open HEKLA Electron app from desktop
- [ ] Setup wizard runs automatically on first boot
- [ ] Click "Connect Microsoft Account"
- [ ] Complete OAuth flow in browser
- [ ] Setup wizard runs smoke tests automatically
- [ ] All tests should show green checkmarks

### Communication Setup
- [ ] Scan QR code to add Telegram bot
- [ ] Or note bot username: `@hekla_[devicename]_bot`
- [ ] Send first message: "Hello HEKLA"
- [ ] Verify response comes back

### Verification
- [ ] Ask "What's in my inbox?" (requires OAuth complete)
- [ ] Ask "What meetings do I have today?"
- [ ] Ask HEKLA to remember something, then recall it later
- [ ] Verify response quality matches tier expectations

---

## Troubleshooting

### Ollama not responding
```bash
# Ollama runs natively (NOT in Docker)
ollama list                    # Check loaded models
ollama serve                   # Restart Ollama
curl http://localhost:11434/api/tags  # Verify
```

### OAuth token expired
1. Open Electron app
2. Go to Settings → Connected Accounts
3. Click "Re-authorize"

### Agent stuck in queue
```bash
# Each agent is isolated — restart the stuck one
docker compose restart mail-agent    # or calendar-agent, memory-agent
# Nuclear option: flush the queue
docker exec hekla-redis redis-cli FLUSHALL
docker compose restart orchestrator mail-agent calendar-agent memory-agent
```

### One agent crashed (isolation test)
```bash
# Kill an agent — others should keep working
docker stop hekla-mail
# Verify other agents still respond:
curl -X POST http://localhost:3000/api/task \
  -H 'Content-Type: application/json' \
  -d '{"userId":"test","message":"What meetings do I have?"}'
# Bring it back:
docker start hekla-mail
```

### Model too slow
```bash
# Switch to a smaller model
ollama pull qwen2.5:14b
# Update .env: ACTIVE_MODEL=qwen2.5:14b
docker compose restart orchestrator mail-agent calendar-agent memory-agent
```

### Docker containers can't reach Ollama
```bash
# Verify host.docker.internal resolves from inside Docker
docker run --rm alpine ping -c1 host.docker.internal
# If it doesn't work, check Docker Desktop settings
# Or set OLLAMA_URL=http://<host-ip>:11434 in .env
```

### Service won't start
```bash
docker compose logs [service-name]
docker compose down && docker compose up -d
```

### Out of disk space (models)
```bash
ollama list
ollama rm [unused-model]
```

---

## Support Escalation

1. Customer describes issue
2. Collect logs: `docker compose logs > /tmp/hekla-logs.txt`
3. Check Langfuse traces at http://localhost:3001
4. Check Ollama status: `ollama list && curl http://localhost:11434/api/tags`
5. If hardware issue: Apple warranty / RMA process
6. If software: remote SSH debug session (with customer permission)

---

## Emergency Recovery

If system is completely broken:
```bash
cd ~/hekla
docker compose down -v    # WARNING: destroys database data
ollama rm --all           # Remove all models
git pull origin main
./scripts/setup.sh        # Fresh setup
```

Customer will need to re-authenticate OAuth after this.

---

## Alternative Setup (Subscription Customers)

For customers who don't want full OAuth integration:

1. **Mail forwarding**: Set `MAIL_FORWARD_ENABLED=true` in .env, provide forwarding address
2. **Telegram only**: All interactions through the Telegram bot, no Electron needed
3. **Cloud overflow**: Set `HYBRID_MODE=true` and `OPENROUTER_API_KEY` for complex tasks

---

**https://www.hekla.cc/**
