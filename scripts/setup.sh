#!/bin/bash
# HEKLA First Boot Setup Script — Mac Mini M4
# https://www.hekla.cc/
# Run with: ./scripts/setup.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ██╗  ██╗███████╗██╗  ██╗██╗      █████╗ "
echo "  ██║  ██║██╔════╝██║ ██╔╝██║     ██╔══██╗"
echo "  ███████║█████╗  █████╔╝ ██║     ███████║"
echo "  ██╔══██║██╔══╝  ██╔═██╗ ██║     ██╔══██║"
echo "  ██║  ██║███████╗██║  ██╗███████╗██║  ██║"
echo "  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝"
echo -e "${NC}"
echo "  Local AI Personal Assistant — Mac Mini M4 Setup"
echo "  https://www.hekla.cc/"
echo ""

# ─── Step 1: System Check ────────────────
echo -e "${BLUE}[1/7] System Check${NC}"

# Verify macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "  ${YELLOW}!${NC} Not running on macOS. This setup is designed for Mac Mini M4."
    echo "    For Linux, set OLLAMA_URL in .env to your Ollama endpoint."
fi

# Detect Apple Silicon
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
    echo -e "  ${GREEN}✓${NC} Apple Silicon detected (${ARCH})"
else
    echo -e "  ${YELLOW}!${NC} Expected Apple Silicon (arm64), got ${ARCH}"
fi

# Detect memory (unified memory = VRAM on Apple Silicon)
if [[ "$(uname)" == "Darwin" ]]; then
    TOTAL_MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
    echo -e "  ${GREEN}✓${NC} Unified Memory: ${TOTAL_MEM_GB}GB"

    if [ "$TOTAL_MEM_GB" -ge 64 ]; then
        RECOMMENDED_MODEL="llama3.3:70b"
        TIER="max"
        COMPOSE_PROFILE="--profile full"
        echo -e "  ${CYAN}→${NC} Tier: ${GREEN}MAX${NC} — Near-SOTA local performance"
    elif [ "$TOTAL_MEM_GB" -ge 36 ]; then
        RECOMMENDED_MODEL="qwen2.5:32b"
        TIER="pro"
        COMPOSE_PROFILE="--profile full"
        echo -e "  ${CYAN}→${NC} Tier: ${GREEN}PRO${NC} — Full capability, optimal balance"
    elif [ "$TOTAL_MEM_GB" -ge 24 ]; then
        RECOMMENDED_MODEL="qwen2.5:14b"
        TIER="base+"
        COMPOSE_PROFILE=""
        echo -e "  ${CYAN}→${NC} Tier: ${YELLOW}BASE+${NC} — Good for core PA tasks"
    elif [ "$TOTAL_MEM_GB" -ge 16 ]; then
        RECOMMENDED_MODEL="qwen2.5:7b"
        TIER="base"
        COMPOSE_PROFILE=""
        echo -e "  ${CYAN}→${NC} Tier: ${YELLOW}BASE${NC} — Core PA tasks (Langfuse disabled to save RAM)"
    else
        RECOMMENDED_MODEL="qwen2.5:3b"
        TIER="mini"
        COMPOSE_PROFILE=""
        echo -e "  ${CYAN}→${NC} Tier: ${RED}MINI${NC} — Very limited, 16GB minimum recommended"
    fi
    echo -e "  ${CYAN}→${NC} Recommended model: ${RECOMMENDED_MODEL}"
else
    TOTAL_MEM_GB="unknown"
    RECOMMENDED_MODEL="qwen2.5:14b"
    TIER="base"
fi

# ─── Step 2: Dependencies ────────────────
echo -e "\n${BLUE}[2/7] Dependencies${NC}"

# Homebrew
if command -v brew &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Homebrew installed"
else
    echo -e "  ${RED}✗${NC} Homebrew not found. Install: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
    exit 1
fi

# Docker
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}' | tr -d ',')
    echo -e "  ${GREEN}✓${NC} Docker installed: v${DOCKER_VERSION}"
else
    echo -e "  ${RED}✗${NC} Docker not found. Install Docker Desktop for Mac."
    echo "    brew install --cask docker"
    exit 1
fi

if command -v docker compose &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Docker Compose available"
else
    echo -e "  ${RED}✗${NC} Docker Compose not found (included with Docker Desktop)"
    exit 1
fi

# Ollama (native — NOT in Docker)
if command -v ollama &> /dev/null; then
    OLLAMA_VERSION=$(ollama --version 2>/dev/null || echo "unknown")
    echo -e "  ${GREEN}✓${NC} Ollama installed: ${OLLAMA_VERSION}"
else
    echo -e "  ${CYAN}→${NC} Installing Ollama..."
    brew install ollama
    echo -e "  ${GREEN}✓${NC} Ollama installed"
fi

# ─── Step 3: Environment Setup ────────────
echo -e "\n${BLUE}[3/7] Environment Configuration${NC}"

if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "  ${GREEN}✓${NC} Created .env from template"

    # Generate secrets
    POSTGRES_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
    NEXTAUTH_SECRET=$(openssl rand -base64 32)
    LANGFUSE_SALT=$(openssl rand -base64 32)

    # Update .env
    sed -i '' "s/your_secure_password_here/${POSTGRES_PW}/" .env 2>/dev/null || sed -i "s/your_secure_password_here/${POSTGRES_PW}/" .env
    sed -i '' "s/generate_with_openssl_rand_base64_32/${NEXTAUTH_SECRET}/" .env 2>/dev/null || sed -i "s/generate_with_openssl_rand_base64_32/${NEXTAUTH_SECRET}/" .env
    sed -i '' "s|ACTIVE_MODEL=.*|ACTIVE_MODEL=${RECOMMENDED_MODEL}|" .env 2>/dev/null || sed -i "s|ACTIVE_MODEL=.*|ACTIVE_MODEL=${RECOMMENDED_MODEL}|" .env
    sed -i '' "s|DEVICE_TIER=.*|DEVICE_TIER=${TIER}|" .env 2>/dev/null || sed -i "s|DEVICE_TIER=.*|DEVICE_TIER=${TIER}|" .env

    echo -e "  ${GREEN}✓${NC} Generated secure passwords"
    echo -e "  ${GREEN}✓${NC} Set model: ${RECOMMENDED_MODEL} (tier: ${TIER})"
else
    echo -e "  ${CYAN}→${NC} Using existing .env file"
fi

# ─── Step 4: Start Ollama (native) ────────
echo -e "\n${BLUE}[4/7] Starting Ollama (native Metal acceleration)${NC}"

# Check if Ollama is already running
if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Ollama already running"
else
    echo -e "  ${CYAN}→${NC} Starting Ollama..."
    # On macOS, Ollama runs as a native process (uses Metal GPU)
    ollama serve &>/dev/null &
    OLLAMA_PID=$!
    echo -e "  ${CYAN}→${NC} Waiting for Ollama to be ready..."
    sleep 3

    for i in {1..30}; do
        if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
            echo -e "  ${GREEN}✓${NC} Ollama is ready (PID: ${OLLAMA_PID})"
            break
        fi
        sleep 2
    done
fi

# ─── Step 5: Pull Model ──────────────────
echo -e "\n${BLUE}[5/7] Pulling Model: ${RECOMMENDED_MODEL}${NC}"
echo -e "  ${CYAN}→${NC} This may take a while depending on your connection..."
ollama pull ${RECOMMENDED_MODEL}
echo -e "  ${GREEN}✓${NC} Model ready"

# ─── Step 6: Start Docker Stack ──────────
echo -e "\n${BLUE}[6/7] Starting Docker Stack${NC}"
echo -e "  ${CYAN}→${NC} Ollama runs natively — Docker containers connect via host.docker.internal"
if [ -n "$COMPOSE_PROFILE" ]; then
    echo -e "  ${CYAN}→${NC} Starting with Langfuse (enough memory)"
    docker compose ${COMPOSE_PROFILE} up -d
else
    echo -e "  ${CYAN}→${NC} Starting core services (Langfuse skipped to save RAM)"
    docker compose up -d
fi
echo -e "  ${CYAN}→${NC} Waiting for services..."
sleep 10

# Check services
SERVICES=("postgres" "redis" "gateway" "orchestrator")
for service in "${SERVICES[@]}"; do
    if docker compose ps | grep -q "${service}.*running\|${service}.*Up"; then
        echo -e "  ${GREEN}✓${NC} ${service} running"
    else
        echo -e "  ${YELLOW}!${NC} ${service} starting..."
    fi
done

# ─── Step 7: Smoke Test ──────────────────
echo -e "\n${BLUE}[7/7] Smoke Test${NC}"
echo -e "  ${CYAN}→${NC} Testing Ollama inference (Metal GPU)..."

RESPONSE=$(curl -sf http://localhost:11434/api/chat -d '{
  "model": "'${RECOMMENDED_MODEL}'",
  "messages": [{"role": "user", "content": "Say HEKLA"}],
  "stream": false
}' 2>/dev/null | grep -o '"content":"[^"]*"' | head -1 || echo "")

if [ -n "$RESPONSE" ]; then
    echo -e "  ${GREEN}✓${NC} Inference working (Apple Metal acceleration)"
else
    echo -e "  ${YELLOW}!${NC} Inference test skipped (model may still be loading)"
fi

# Test gateway
if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo -e "  ${GREEN}✓${NC} Gateway responding"
else
    echo -e "  ${YELLOW}!${NC} Gateway not ready yet (may need a few more seconds)"
fi

# Done
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  HEKLA Setup Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "  Hardware: Mac Mini M4 (${TOTAL_MEM_GB}GB unified memory)"
echo "  Tier:     ${TIER}"
echo "  Model:    ${RECOMMENDED_MODEL}"
echo ""
echo "  Services running:"
echo "  • Gateway:  http://localhost:3000"
echo "  • Langfuse: http://localhost:3001"
echo "  • Ollama:   http://localhost:11434 (native Metal)"
echo ""
echo "  Next steps:"
echo "  1. Run QA tests: node scripts/qa.js"
echo "  2. Open the Electron app for OAuth setup"
echo "  3. Connect via Telegram or test the API"
echo ""
echo "  https://www.hekla.cc/"
echo ""
