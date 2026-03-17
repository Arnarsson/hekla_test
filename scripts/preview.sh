#!/bin/bash
# HEKLA Preview / Pre-flight Check — Mac Mini M4
# https://www.hekla.cc/
#
# Validates the stack configuration without starting containers.
# Run with: ./scripts/preview.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

ERRORS=0
WARNINGS=0

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; WARNINGS=$((WARNINGS + 1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }

echo -e "${CYAN}"
echo "  HEKLA Stack Preview (Mac Mini M4)"
echo "  ═══════════════════════════════════"
echo -e "${NC}"

# ─── Prerequisites ───────────────────────
echo -e "${BLUE}[1/7] Prerequisites${NC}"

if command -v docker &> /dev/null; then
    pass "Docker installed: $(docker --version | awk '{print $3}' | tr -d ',')"
else
    fail "Docker not installed"
fi

if command -v docker compose &> /dev/null; then
    pass "Docker Compose available"
else
    fail "Docker Compose not found"
fi

if command -v node &> /dev/null; then
    pass "Node.js installed: $(node --version)"
else
    warn "Node.js not found (needed for QA tests)"
fi

if docker info &> /dev/null; then
    pass "Docker daemon is running"
else
    warn "Docker daemon is not running (cannot start services)"
fi

# ─── Ollama (Native) ────────────────────
echo -e "\n${BLUE}[2/7] Ollama (Native)${NC}"

if command -v ollama &> /dev/null; then
    pass "Ollama installed"
else
    warn "Ollama not installed — run: brew install ollama"
fi

if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    pass "Ollama is running on :11434"
    MODELS=$(curl -sf http://localhost:11434/api/tags | grep -o '"name":"[^"]*"' | sed 's/"name":"//;s/"//' | tr '\n' ', ' | sed 's/,$//')
    if [ -n "$MODELS" ]; then
        pass "Models loaded: ${MODELS}"
    else
        warn "No models loaded — run: ollama pull qwen2.5:32b"
    fi
else
    warn "Ollama is not running — run: ollama serve"
fi

# ─── Hardware Detection ─────────────────
echo -e "\n${BLUE}[3/7] Hardware${NC}"

if [[ "$(uname)" == "Darwin" ]]; then
    ARCH=$(uname -m)
    if [[ "$ARCH" == "arm64" ]]; then
        pass "Apple Silicon (${ARCH})"
    else
        warn "Expected Apple Silicon (arm64), got ${ARCH}"
    fi

    TOTAL_MEM_GB=$(( $(sysctl -n hw.memsize) / 1073741824 ))
    pass "Unified Memory: ${TOTAL_MEM_GB}GB"

    if [ "$TOTAL_MEM_GB" -ge 64 ]; then
        echo -e "    ${CYAN}→ Tier: MAX — llama3.3:70b (near-SOTA)${NC}"
        echo -e "    ${CYAN}→ Start: docker compose --profile full up -d${NC}"
    elif [ "$TOTAL_MEM_GB" -ge 36 ]; then
        echo -e "    ${CYAN}→ Tier: PRO — qwen2.5:32b (optimal)${NC}"
        echo -e "    ${CYAN}→ Start: docker compose --profile full up -d${NC}"
    elif [ "$TOTAL_MEM_GB" -ge 16 ]; then
        echo -e "    ${CYAN}→ Tier: BASE — qwen2.5:7b${NC}"
        echo -e "    ${CYAN}→ Start: docker compose up -d  (Langfuse disabled to save RAM)${NC}"
    else
        warn "Only ${TOTAL_MEM_GB}GB — minimum 16GB required"
    fi
else
    warn "Not running on macOS (target: Mac Mini M4)"
fi

# ─── Configuration Files ─────────────────
echo -e "\n${BLUE}[4/7] Configuration${NC}"

if [ -f docker-compose.yml ]; then
    pass "docker-compose.yml found"
    # Verify no Ollama container in compose
    if grep -q "ollama/ollama" docker-compose.yml 2>/dev/null; then
        fail "docker-compose.yml should NOT contain Ollama container (runs natively)"
    else
        pass "Ollama correctly excluded from Docker (runs native Metal)"
    fi
    # Verify host.docker.internal
    if grep -q "host.docker.internal" docker-compose.yml 2>/dev/null; then
        pass "Agents connect to host Ollama via host.docker.internal"
    else
        fail "Missing host.docker.internal — agents can't reach native Ollama"
    fi
else
    fail "docker-compose.yml missing"
fi

if [ -f .env ]; then
    pass ".env file exists"
    if grep -q "your_secure_password_here" .env 2>/dev/null; then
        warn ".env still has placeholder POSTGRES_PASSWORD"
    fi
elif [ -f .env.example ]; then
    warn ".env not found — run: cp .env.example .env && ./scripts/setup.sh"
else
    fail ".env.example missing"
fi

if [ -f postgres/init.sql ]; then
    pass "Database schema found"
else
    fail "Database schema missing"
fi

# ─── Services ────────────────────────────
echo -e "\n${BLUE}[5/7] Service Files${NC}"

SERVICES=(
    "services/gateway:Gateway"
    "services/agents/orchestrator:Orchestrator"
    "services/agents/mail:Mail Agent"
    "services/agents/calendar:Calendar Agent"
    "services/agents/memory:Memory Agent"
)

for entry in "${SERVICES[@]}"; do
    DIR=$(echo "$entry" | cut -d: -f1)
    NAME=$(echo "$entry" | cut -d: -f2)
    if [ -f "$DIR/index.js" ] && [ -f "$DIR/package.json" ] && [ -f "$DIR/Dockerfile" ]; then
        pass "$NAME ($DIR)"
    else
        MISSING=""
        [ ! -f "$DIR/index.js" ] && MISSING="${MISSING} index.js"
        [ ! -f "$DIR/package.json" ] && MISSING="${MISSING} package.json"
        [ ! -f "$DIR/Dockerfile" ] && MISSING="${MISSING} Dockerfile"
        fail "$NAME missing:${MISSING}"
    fi
done

# ─── Compose Validation ─────────────────
echo -e "\n${BLUE}[6/7] Compose Validation${NC}"

if command -v docker &> /dev/null && docker info &> /dev/null; then
    if POSTGRES_PASSWORD=test NEXTAUTH_SECRET=test LANGFUSE_SALT=test docker compose config --quiet 2>/dev/null; then
        pass "docker-compose.yml validates successfully"
    else
        fail "docker-compose.yml has validation errors"
    fi
else
    warn "Cannot validate compose files (Docker not running)"
fi

# ─── Offline Tests ───────────────────────
echo -e "\n${BLUE}[7/7] Offline Tests${NC}"

if [ -f tests/run-tests.js ]; then
    echo ""
    node tests/run-tests.js
    TEST_EXIT=$?
    if [ $TEST_EXIT -ne 0 ]; then
        ERRORS=$((ERRORS + 1))
    fi
else
    warn "Offline test suite not found"
fi

# ─── Summary ─────────────────────────────
echo ""
echo -e "${CYAN}  ═══════════════════════════════${NC}"
if [ $ERRORS -eq 0 ]; then
    echo -e "  ${GREEN}Preview complete: stack looks good!${NC}"
else
    echo -e "  ${RED}Preview found ${ERRORS} error(s)${NC}"
fi
if [ $WARNINGS -gt 0 ]; then
    echo -e "  ${YELLOW}${WARNINGS} warning(s)${NC}"
fi
echo -e "${CYAN}  ═══════════════════════════════${NC}"
echo ""

if [ $ERRORS -eq 0 ]; then
    echo "  Ready to start:"
    echo "    1. ollama serve                           # Start Ollama (native Metal)"
    echo "    2. docker compose up -d                   # Base (16GB) — core services"
    echo "       docker compose --profile full up -d    # Full (36GB+) — adds Langfuse"
    echo "    3. node scripts/qa.js                     # Run live QA tests"
    echo ""
    echo "  https://www.hekla.cc/"
    echo ""
fi

exit $ERRORS
