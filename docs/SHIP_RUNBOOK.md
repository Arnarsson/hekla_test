# HEKLA Ship Runbook

Production checklist for shipping HEKLA devices to customers.

---

## Pre-Ship (Our Side)

### Hardware Setup
- [ ] Flash Ubuntu 24.04 LTS on the device
- [ ] Verify GPU is detected: `nvidia-smi`
- [ ] Note VRAM and assign tier (16-24GB = Personal, 36GB+ = High Performance)

### Software Installation
- [ ] Install Docker: `curl -fsSL https://get.docker.com | sh`
- [ ] Install NVIDIA Container Toolkit
- [ ] Clone HEKLA: `git clone <repo> /opt/hekla`
- [ ] Run setup: `cd /opt/hekla && ./scripts/setup.sh`

### Model & Services
- [ ] Verify correct model pulled for tier
- [ ] Run `docker compose up -d` and verify all services healthy
- [ ] Run QA tests: `node scripts/qa.js` (all should pass)

### Pre-configuration
- [ ] Set `DEVICE_SERIAL` in .env to unit's serial number
- [ ] Set `DEVICE_TIER` in .env (personal / high-performance)
- [ ] Set `DEVICE_NAME` in .env (customer's chosen name)
- [ ] Package Electron app installer on desktop

### Final Checks
- [ ] Reboot device and verify services auto-start
- [ ] Test Ollama inference responds
- [ ] Langfuse accessible at localhost:3001
- [ ] Document any special configuration

---

## Customer Onboarding (Their Side)

### Physical Setup
- [ ] Unbox and connect device to power
- [ ] Connect to their network (ethernet recommended)
- [ ] Note device IP address

### Software Setup
- [ ] Open Electron app from desktop (auto-runs setup wizard if first boot)
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
- [ ] Ask "What's in my inbox?" (should work if OAuth complete)
- [ ] Ask "What meetings do I have today?"
- [ ] Ask HEKLA to remember something, then recall it

---

## Troubleshooting

### Ollama not responding
```bash
docker compose restart ollama
docker compose logs ollama
```

### OAuth token expired
1. Open Electron app
2. Go to Settings → Connected Accounts
3. Click "Re-authorize"

### Agent stuck in queue
```bash
docker exec hekla-redis redis-cli FLUSHALL
docker compose restart orchestrator mail-agent calendar-agent
```

### Model too slow
```bash
# Switch to smaller model
docker exec hekla-ollama ollama pull qwen2.5:7b
# Update .env: ACTIVE_MODEL=qwen2.5:7b
docker compose restart orchestrator mail-agent calendar-agent memory-agent
```

### Service won't start
```bash
docker compose logs [service-name]
docker compose down && docker compose up -d
```

### Out of disk space (models)
```bash
docker exec hekla-ollama ollama list
docker exec hekla-ollama ollama rm [unused-model]
```

---

## Support Escalation

1. Customer describes issue
2. Collect: `docker compose logs > /tmp/hekla-logs.txt`
3. Check Langfuse traces at http://localhost:3001
4. If hardware issue: RMA process
5. If software: remote SSH debug session

---

## Emergency Recovery

If system is completely broken:
```bash
cd /opt/hekla
docker compose down -v  # WARNING: destroys data
git pull origin main
./scripts/setup.sh
```

Customer will need to re-authenticate OAuth after this.
