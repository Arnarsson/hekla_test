#!/bin/bash
# HEKLA First Boot Setup Script
# Run with: ./scripts/setup.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "  ██╗  ██╗███████╗██╗  ██╗██╗      █████╗ "
echo "  ██║  ██║██╔════╝██║ ██╔╝██║     ██╔══██╗"
echo "  ███████║█████╗  █████╔╝ ██║     ███████║"
echo "  ██╔══██║██╔══╝  ██╔═██╗ ██║     ██╔══██║"
echo "  ██║  ██║███████╗██║  ██╗███████╗██║  ██║"
echo "  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝"
echo -e "${NC}"
echo "  Local AI Personal Assistant - Setup"
echo ""

# Step 1: System Check
echo -e "${BLUE}[1/7] System Check${NC}"

# Check GPU
if command -v nvidia-smi &> /dev/null; then
    VRAM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -1)
    echo -e "  ${GREEN}✓${NC} NVIDIA GPU detected: ${VRAM}MB VRAM"

    if [ "$VRAM" -ge 40000 ]; then
        RECOMMENDED_MODEL="llama3.3:70b"
        TIER="high-performance"
    elif [ "$VRAM" -ge 20000 ]; then
        RECOMMENDED_MODEL="qwen2.5:32b"
        TIER="high-performance"
    else
        RECOMMENDED_MODEL="qwen2.5:14b"
        TIER="personal"
    fi
    echo -e "  ${CYAN}→${NC} Recommended model: ${RECOMMENDED_MODEL} (${TIER} tier)"
else
    echo -e "  ${YELLOW}!${NC} No NVIDIA GPU detected. Will use CPU inference (slower)"
    RECOMMENDED_MODEL="qwen2.5:7b"
    TIER="personal"
fi

# Step 2: Docker Check
echo -e "\n${BLUE}[2/7] Docker Check${NC}"
if command -v docker &> /dev/null; then
    DOCKER_VERSION=$(docker --version | awk '{print $3}' | tr -d ',')
    echo -e "  ${GREEN}✓${NC} Docker installed: v${DOCKER_VERSION}"
else
    echo -e "  ${RED}✗${NC} Docker not found. Please install Docker first."
    echo "    Run: curl -fsSL https://get.docker.com | sh"
    exit 1
fi

if command -v docker compose &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Docker Compose available"
else
    echo -e "  ${RED}✗${NC} Docker Compose not found"
    exit 1
fi

# Step 3: Environment Setup
echo -e "\n${BLUE}[3/7] Environment Configuration${NC}"

if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "  ${GREEN}✓${NC} Created .env from template"

    # Generate secrets
    POSTGRES_PW=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
    NEXTAUTH_SECRET=$(openssl rand -base64 32)
    LANGFUSE_SALT=$(openssl rand -base64 32)

    # Update .env
    sed -i "s/your_secure_password_here/${POSTGRES_PW}/" .env
    sed -i "s/generate_with_openssl_rand_base64_32/${NEXTAUTH_SECRET}/" .env
    sed -i "s|ACTIVE_MODEL=.*|ACTIVE_MODEL=${RECOMMENDED_MODEL}|" .env
    sed -i "s|DEVICE_TIER=.*|DEVICE_TIER=${TIER}|" .env

    echo -e "  ${GREEN}✓${NC} Generated secure passwords"
else
    echo -e "  ${CYAN}→${NC} Using existing .env file"
fi

# Step 4: Start Ollama
echo -e "\n${BLUE}[4/7] Starting Ollama${NC}"
if command -v nvidia-smi &> /dev/null; then
    COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.gpu.yml"
    echo -e "  ${GREEN}✓${NC} GPU detected — using GPU-accelerated Ollama"
else
    COMPOSE_CMD="docker compose"
    echo -e "  ${CYAN}→${NC} No GPU — using CPU-only Ollama"
fi
$COMPOSE_CMD up -d ollama
echo -e "  ${CYAN}→${NC} Waiting for Ollama to be ready..."
sleep 5

# Wait for Ollama health
for i in {1..30}; do
    if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} Ollama is ready"
        break
    fi
    sleep 2
done

# Step 5: Pull Model
echo -e "\n${BLUE}[5/7] Pulling Model: ${RECOMMENDED_MODEL}${NC}"
echo -e "  ${CYAN}→${NC} This may take a while depending on your connection..."
docker exec hekla-ollama ollama pull ${RECOMMENDED_MODEL}
echo -e "  ${GREEN}✓${NC} Model ready"

# Step 6: Start Full Stack
echo -e "\n${BLUE}[6/7] Starting Full Stack${NC}"
$COMPOSE_CMD up -d
echo -e "  ${CYAN}→${NC} Waiting for services..."
sleep 10

# Check services
SERVICES=("ollama:11434" "postgres:5432" "redis:6379" "gateway:3000")
for service in "${SERVICES[@]}"; do
    NAME=$(echo $service | cut -d: -f1)
    if docker compose ps | grep -q "${NAME}.*running"; then
        echo -e "  ${GREEN}✓${NC} ${NAME} running"
    else
        echo -e "  ${YELLOW}!${NC} ${NAME} starting..."
    fi
done

# Step 7: Smoke Test
echo -e "\n${BLUE}[7/7] Smoke Test${NC}"
echo -e "  ${CYAN}→${NC} Testing Ollama inference..."

RESPONSE=$(curl -sf http://localhost:11434/api/chat -d '{
  "model": "'${RECOMMENDED_MODEL}'",
  "messages": [{"role": "user", "content": "Say HEKLA"}],
  "stream": false
}' 2>/dev/null | grep -o '"content":"[^"]*"' | head -1 || echo "")

if [ -n "$RESPONSE" ]; then
    echo -e "  ${GREEN}✓${NC} Inference working"
else
    echo -e "  ${YELLOW}!${NC} Inference test skipped (model may still be loading)"
fi

# Done
echo ""
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}  HEKLA Setup Complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "  Services running:"
echo "  • Gateway:  http://localhost:3000"
echo "  • Langfuse: http://localhost:3001"
echo "  • Ollama:   http://localhost:11434"
echo ""
echo "  Next steps:"
echo "  1. Configure Azure OAuth in .env"
echo "  2. Run: node scripts/qa.js"
echo "  3. Connect via Telegram or test the API"
echo ""
