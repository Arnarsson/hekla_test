#!/bin/bash
# HEKLA — One-Script Launch
# https://www.hekla.cc/
#
# Starts the entire stack: Ollama → Docker services → Electron app
# Usage: ./scripts/launch.sh [--no-electron] [--full]
#
# Options:
#   --no-electron   Skip launching the desktop app
#   --full          Start with Langfuse (requires 36GB+ RAM)
#   --stop          Stop everything

set -e

# ─── Colors ────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
ORANGE='\033[38;5;208m'
NC='\033[0m'

# ─── Parse args ────────────────────────────
LAUNCH_ELECTRON=true
COMPOSE_PROFILE=""
STOP_MODE=false

for arg in "$@"; do
  case "$arg" in
    --no-electron) LAUNCH_ELECTRON=false ;;
    --full)        COMPOSE_PROFILE="--profile full" ;;
    --stop)        STOP_MODE=true ;;
  esac
done

# ─── Resolve project root ─────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ─── Banner ────────────────────────────────
echo -e "${ORANGE}"
echo "  ██╗  ██╗███████╗██╗  ██╗██╗      █████╗ "
echo "  ██║  ██║██╔════╝██║ ██╔╝██║     ██╔══██╗"
echo "  ███████║█████╗  █████╔╝ ██║     ███████║"
echo "  ██╔══██║██╔══╝  ██╔═██╗ ██║     ██╔══██║"
echo "  ██║  ██║███████╗██║  ██╗███████╗██║  ██║"
echo "  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝"
echo -e "${NC}"

# ─── Stop mode ─────────────────────────────
if [ "$STOP_MODE" = true ]; then
  echo -e "${ORANGE}Stopping HEKLA...${NC}"
  echo ""

  # Stop Electron
  if pgrep -f "electron.*hekla" > /dev/null 2>&1; then
    pkill -f "electron.*hekla" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Electron app stopped"
  else
    echo -e "  ${YELLOW}—${NC} Electron app not running"
  fi

  # Stop Docker services
  if command -v docker &> /dev/null && docker info &> /dev/null 2>&1; then
    docker compose --profile full down 2>/dev/null || docker compose down 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Docker services stopped"
  else
    echo -e "  ${YELLOW}—${NC} Docker not running"
  fi

  echo ""
  echo -e "  ${ORANGE}Ollama left running (shared resource).${NC}"
  echo "  Stop manually with: pkill ollama"
  echo ""
  exit 0
fi

echo -e "  ${ORANGE}Launching full stack...${NC}"
echo ""

ERRORS=0

# ════════════════════════════════════════════
# 1. ENVIRONMENT
# ════════════════════════════════════════════
echo -e "${ORANGE}[1/5] Environment${NC}"

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo -e "  ${GREEN}✓${NC} Created .env from template"

    # Generate secrets
    POSTGRES_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
    NEXTAUTH_SECRET=$(openssl rand -base64 32)
    LANGFUSE_SALT=$(openssl rand -base64 32)

    sed -i '' "s/your_secure_password_here/${POSTGRES_PW}/" .env 2>/dev/null || sed -i "s/your_secure_password_here/${POSTGRES_PW}/" .env
    sed -i '' "s/generate_with_openssl_rand_base64_32/${NEXTAUTH_SECRET}/" .env 2>/dev/null || sed -i "s/generate_with_openssl_rand_base64_32/${NEXTAUTH_SECRET}/" .env

    echo -e "  ${GREEN}✓${NC} Generated secure passwords"
  else
    echo -e "  ${RED}✗${NC} No .env or .env.example found"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo -e "  ${GREEN}✓${NC} .env exists"
fi

# Detect memory tier (macOS only)
if [[ "$(uname)" == "Darwin" ]]; then
  TOTAL_MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  if [ "$TOTAL_MEM_GB" -ge 64 ]; then
    RECOMMENDED_MODEL="llama3.3:70b"
    TIER="MAX"
  elif [ "$TOTAL_MEM_GB" -ge 36 ]; then
    RECOMMENDED_MODEL="qwen2.5:32b"
    TIER="PRO"
  elif [ "$TOTAL_MEM_GB" -ge 24 ]; then
    RECOMMENDED_MODEL="qwen2.5:14b"
    TIER="BASE+"
  elif [ "$TOTAL_MEM_GB" -ge 16 ]; then
    RECOMMENDED_MODEL="qwen2.5:7b"
    TIER="BASE"
  else
    RECOMMENDED_MODEL="qwen2.5:3b"
    TIER="MINI"
  fi
  echo -e "  ${GREEN}✓${NC} ${TOTAL_MEM_GB}GB unified memory — tier: ${TIER}"

  # Auto-enable full profile for 36GB+ if not explicitly set
  if [ "$TOTAL_MEM_GB" -ge 36 ] && [ -z "$COMPOSE_PROFILE" ]; then
    COMPOSE_PROFILE="--profile full"
    echo -e "  ${ORANGE}→${NC} Auto-enabling Langfuse (enough RAM)"
  fi
else
  RECOMMENDED_MODEL="qwen2.5:7b"
  TIER="BASE"
  echo -e "  ${YELLOW}!${NC} Not macOS — defaulting to ${RECOMMENDED_MODEL}"
fi

# Read model from .env if set, otherwise use recommended
ACTIVE_MODEL=$(grep "^ACTIVE_MODEL=" .env 2>/dev/null | cut -d= -f2)
if [ -z "$ACTIVE_MODEL" ] || [ "$ACTIVE_MODEL" = "qwen2.5:7b" ]; then
  ACTIVE_MODEL="$RECOMMENDED_MODEL"
fi
echo -e "  ${GREEN}✓${NC} Model: ${ACTIVE_MODEL}"

# ════════════════════════════════════════════
# 2. OLLAMA (native — Metal GPU on macOS)
# ════════════════════════════════════════════
echo -e "\n${ORANGE}[2/5] Ollama${NC}"

if ! command -v ollama &> /dev/null; then
  echo -e "  ${RED}✗${NC} Ollama not installed"
  echo "    Install: brew install ollama"
  ERRORS=$((ERRORS + 1))
else
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Ollama already running"
  else
    echo -e "  ${ORANGE}→${NC} Starting Ollama..."
    ollama serve &>/dev/null &
    OLLAMA_PID=$!

    for i in $(seq 1 30); do
      if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Ollama started (PID: ${OLLAMA_PID})"
        break
      fi
      if [ "$i" -eq 30 ]; then
        echo -e "  ${RED}✗${NC} Ollama failed to start after 60s"
        ERRORS=$((ERRORS + 1))
      fi
      sleep 2
    done
  fi

  # Ensure model is pulled
  MODELS=$(curl -sf http://localhost:11434/api/tags 2>/dev/null | grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' || echo "")
  if echo "$MODELS" | grep -q "$ACTIVE_MODEL"; then
    echo -e "  ${GREEN}✓${NC} Model ${ACTIVE_MODEL} available"
  else
    echo -e "  ${ORANGE}→${NC} Pulling ${ACTIVE_MODEL} (this may take a while)..."
    ollama pull "$ACTIVE_MODEL"
    echo -e "  ${GREEN}✓${NC} Model ${ACTIVE_MODEL} pulled"
  fi
fi

# ════════════════════════════════════════════
# 3. DOCKER SERVICES
# ════════════════════════════════════════════
echo -e "\n${ORANGE}[3/5] Docker Services${NC}"

if ! command -v docker &> /dev/null; then
  echo -e "  ${RED}✗${NC} Docker not installed"
  echo "    Install: brew install --cask docker"
  ERRORS=$((ERRORS + 1))
elif ! docker info &> /dev/null 2>&1; then
  echo -e "  ${RED}✗${NC} Docker daemon not running"
  echo "    Start Docker Desktop, then re-run this script"
  ERRORS=$((ERRORS + 1))
else
  # Check if services are already running
  RUNNING=$(docker compose ps --status running -q 2>/dev/null | wc -l | tr -d ' ')
  if [ "$RUNNING" -ge 4 ]; then
    echo -e "  ${GREEN}✓${NC} Services already running (${RUNNING} containers)"
  else
    echo -e "  ${ORANGE}→${NC} Starting Docker stack..."
    if [ -n "$COMPOSE_PROFILE" ]; then
      echo -e "  ${ORANGE}→${NC} Profile: full (includes Langfuse)"
    fi
    docker compose ${COMPOSE_PROFILE} up -d --build

    echo -e "  ${ORANGE}→${NC} Waiting for services..."
  fi

  # Wait for gateway health
  GATEWAY_READY=false
  for i in $(seq 1 60); do
    if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
      GATEWAY_READY=true
      break
    fi
    if [ $((i % 15)) -eq 0 ]; then
      echo -e "  ${ORANGE}→${NC} Still waiting... (${i}s)"
    fi
    sleep 1
  done

  # Report service status
  SERVICES=("postgres" "redis" "gateway" "orchestrator" "mail-agent" "calendar-agent" "memory-agent")
  for service in "${SERVICES[@]}"; do
    if docker compose ps 2>/dev/null | grep -q "${service}.*running\|${service}.*Up"; then
      echo -e "  ${GREEN}✓${NC} ${service}"
    else
      echo -e "  ${RED}✗${NC} ${service}"
      ERRORS=$((ERRORS + 1))
    fi
  done

  if [ "$GATEWAY_READY" = true ]; then
    echo -e "  ${GREEN}✓${NC} Gateway healthy (http://localhost:3000)"
  else
    echo -e "  ${RED}✗${NC} Gateway not healthy after 60s"
    echo "    Check logs: docker compose logs gateway"
    ERRORS=$((ERRORS + 1))
  fi

  # Langfuse (optional)
  if [ -n "$COMPOSE_PROFILE" ]; then
    if curl -sf http://localhost:3001 > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} Langfuse (http://localhost:3001)"
    else
      echo -e "  ${YELLOW}!${NC} Langfuse starting (may take a minute)"
    fi
  fi
fi

# ════════════════════════════════════════════
# 4. ELECTRON APP
# ════════════════════════════════════════════
echo -e "\n${ORANGE}[4/5] Electron App${NC}"

if [ "$LAUNCH_ELECTRON" = false ]; then
  echo -e "  ${YELLOW}—${NC} Skipped (--no-electron)"
else
  if ! command -v node &> /dev/null; then
    echo -e "  ${RED}✗${NC} Node.js not installed"
    echo "    Install: brew install node"
    ERRORS=$((ERRORS + 1))
  else
    # Install dependencies if needed
    if [ ! -d electron-app/node_modules ]; then
      echo -e "  ${ORANGE}→${NC} Installing dependencies..."
      (cd electron-app && npm install --no-fund --no-audit)
    fi

    # Check if already running
    if pgrep -f "electron.*hekla" > /dev/null 2>&1; then
      echo -e "  ${GREEN}✓${NC} Already running"
    else
      echo -e "  ${ORANGE}→${NC} Launching HEKLA Desktop..."
      (cd electron-app && ACTIVE_MODEL="$ACTIVE_MODEL" npm start &) 2>/dev/null
      ELECTRON_PID=$!
      sleep 3

      if pgrep -f "electron" > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} HEKLA Desktop launched"
      else
        echo -e "  ${RED}✗${NC} Desktop app failed to start"
        echo "    Try manually: cd electron-app && npm start"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  fi
fi

# ════════════════════════════════════════════
# 5. SMOKE TEST
# ════════════════════════════════════════════
echo -e "\n${ORANGE}[5/5] Smoke Test${NC}"

# Ollama inference
RESPONSE=$(curl -sf http://localhost:11434/api/chat -d '{
  "model": "'"${ACTIVE_MODEL}"'",
  "messages": [{"role": "user", "content": "Say HEKLA"}],
  "stream": false
}' 2>/dev/null | grep -o '"content":"[^"]*"' | head -1 || echo "")

if [ -n "$RESPONSE" ]; then
  echo -e "  ${GREEN}✓${NC} Ollama inference working"
else
  echo -e "  ${YELLOW}!${NC} Inference test skipped (model may still be loading)"
fi

# Gateway
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
  echo -e "  ${GREEN}✓${NC} Gateway responding"
else
  echo -e "  ${YELLOW}!${NC} Gateway not reachable"
fi

# ════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════
echo ""
echo -e "${ORANGE}════════════════════════════════════════════${NC}"
if [ $ERRORS -eq 0 ]; then
  echo -e "${ORANGE}  HEKLA is running!${NC}"
else
  echo -e "${RED}  HEKLA launched with ${ERRORS} error(s)${NC}"
fi
echo -e "${ORANGE}════════════════════════════════════════════${NC}"
echo ""
echo "  Model:    ${ACTIVE_MODEL} (${TIER})"
echo "  Gateway:  http://localhost:3000"
echo "  Ollama:   http://localhost:11434"
if [ -n "$COMPOSE_PROFILE" ]; then
  echo "  Langfuse: http://localhost:3001"
fi
echo ""
echo "  Stop:     ./scripts/launch.sh --stop"
echo "  QA:       node scripts/qa.js"
echo "  Logs:     docker compose logs -f"
echo ""
echo "  https://www.hekla.cc/"
echo ""

exit $ERRORS
