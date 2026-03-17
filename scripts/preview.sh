#!/bin/bash
# HEKLA Preview / Pre-flight Check
# Validates the stack configuration without starting any containers.
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
echo "  HEKLA Stack Preview"
echo "  ═══════════════════"
echo -e "${NC}"

# ─── Prerequisites ───────────────────────
echo -e "${BLUE}[1/6] Prerequisites${NC}"

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

# ─── GPU Detection ───────────────────────
echo -e "\n${BLUE}[2/6] GPU Detection${NC}"

if command -v nvidia-smi &> /dev/null; then
    VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
    if [ -n "$VRAM" ]; then
        pass "NVIDIA GPU: ${VRAM}MB VRAM"
        if [ "$VRAM" -ge 40000 ]; then
            echo -e "    ${CYAN}→ Tier: high-performance | Model: llama3.3:70b${NC}"
        elif [ "$VRAM" -ge 20000 ]; then
            echo -e "    ${CYAN}→ Tier: high-performance | Model: qwen2.5:32b${NC}"
        else
            echo -e "    ${CYAN}→ Tier: personal | Model: qwen2.5:14b${NC}"
        fi
        echo -e "    ${CYAN}→ Use: docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d${NC}"
    fi
else
    warn "No NVIDIA GPU detected — will use CPU inference"
    echo -e "    ${CYAN}→ Tier: personal | Model: qwen2.5:7b (recommended for CPU)${NC}"
    echo -e "    ${CYAN}→ Use: docker compose up -d${NC}"
fi

# ─── Configuration Files ─────────────────
echo -e "\n${BLUE}[3/6] Configuration${NC}"

if [ -f docker-compose.yml ]; then
    pass "docker-compose.yml found"
else
    fail "docker-compose.yml missing"
fi

if [ -f docker-compose.gpu.yml ]; then
    pass "docker-compose.gpu.yml (GPU override) found"
else
    warn "docker-compose.gpu.yml not found"
fi

if [ -f .env ]; then
    pass ".env file exists"
    # Check for placeholder values
    if grep -q "your_secure_password_here" .env 2>/dev/null; then
        warn ".env still has placeholder POSTGRES_PASSWORD — run setup.sh to generate"
    fi
    if grep -q "generate_with_openssl" .env 2>/dev/null; then
        warn ".env still has placeholder secrets — run setup.sh to generate"
    fi
elif [ -f .env.example ]; then
    warn ".env not found — will need to copy from .env.example"
    echo -e "    ${CYAN}→ Run: cp .env.example .env && ./scripts/setup.sh${NC}"
else
    fail ".env.example missing"
fi

if [ -f postgres/init.sql ]; then
    pass "Database schema (postgres/init.sql) found"
else
    fail "Database schema missing"
fi

# ─── Services ────────────────────────────
echo -e "\n${BLUE}[4/6] Service Files${NC}"

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
echo -e "\n${BLUE}[5/6] Compose Validation${NC}"

if command -v docker &> /dev/null && docker info &> /dev/null; then
    if docker compose config --quiet 2>/dev/null; then
        pass "docker-compose.yml validates successfully"
    else
        # Try with a dummy env
        if POSTGRES_PASSWORD=test NEXTAUTH_SECRET=test LANGFUSE_SALT=test docker compose config --quiet 2>/dev/null; then
            pass "docker-compose.yml validates (with dummy env vars)"
        else
            fail "docker-compose.yml has validation errors"
        fi
    fi

    if [ -f docker-compose.gpu.yml ]; then
        if POSTGRES_PASSWORD=test NEXTAUTH_SECRET=test LANGFUSE_SALT=test docker compose -f docker-compose.yml -f docker-compose.gpu.yml config --quiet 2>/dev/null; then
            pass "GPU override validates successfully"
        else
            warn "GPU override has validation issues"
        fi
    fi
else
    warn "Cannot validate compose files (Docker not running)"
fi

# ─── Offline Tests ───────────────────────
echo -e "\n${BLUE}[6/6] Offline Tests${NC}"

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

if [ $ERRORS -eq 0 ] && docker info &> /dev/null 2>&1; then
    echo "  Ready to start! Run one of:"
    echo ""
    if command -v nvidia-smi &> /dev/null; then
        echo "    # With GPU:"
        echo "    docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d"
        echo ""
    fi
    echo "    # CPU only:"
    echo "    docker compose up -d"
    echo ""
fi

exit $ERRORS
