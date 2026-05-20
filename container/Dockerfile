# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally (latest versions)
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Pre-install MCP server packages so they don't download at runtime
# Reduces first-response latency significantly
RUN npm install -g \
    @gongrzhe/server-gmail-autoauth-mcp \
    @notionhq/notion-mcp-server \
    @cocal/google-calendar-mcp \
    @modelcontextprotocol/server-google-maps \
    @piotr-agier/google-drive-mcp

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript (used as fallback when host hasn't pre-compiled)
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Apple Container only supports directory mounts (VirtioFS), so .env cannot be
# shadowed with a host-side /dev/null file mount. Instead the entrypoint starts
# as root, uses mount --bind to shadow .env, then drops to the host user via setpriv.
#
# Compilation strategy:
#   - If /tmp/agent-dist/index.js exists (pre-compiled on host and mounted), use it directly.
#   - Otherwise fall back to compiling from /app/src at runtime (~30s overhead).
RUN printf '#!/bin/bash\nset -e\n\n# Shadow .env so the agent cannot read host secrets (requires root)\nif [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then\n  mount --bind /dev/null /workspace/project/.env\nfi\n\n# Use pre-compiled JS if mounted from host, otherwise compile at runtime\nIS_HOST_DIST=0\nif [ -f /tmp/agent-dist/index.js ]; then\n  # Fast path: host pre-compiled, just add node_modules symlink\n  ln -sf /app/node_modules /tmp/agent-dist/node_modules 2>/dev/null || true\n  DIST=/tmp/agent-dist\n  IS_HOST_DIST=1\nelse\n  # Slow path: compile TypeScript inside container\n  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\n  ln -s /app/node_modules /tmp/dist/node_modules\n  chmod -R a-w /tmp/dist\n  DIST=/tmp/dist\nfi\n\n# Capture stdin (secrets JSON) to temp file\ncat > /tmp/input.json\n\n# Drop privileges if running as root (main-group containers)\nif [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then\n  chown "$RUN_UID:$RUN_GID" /tmp/input.json\n  # Only chown DIST when we compiled it locally. Host-mounted dist lives on\n  # VirtioFS which rejects chown inside the container.\n  if [ "$IS_HOST_DIST" = "0" ]; then\n    chown -R "$RUN_UID:$RUN_GID" "$DIST"\n  fi\n  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node "$DIST/index.js" < /tmp/input.json\nfi\n\nexec node "$DIST/index.js" < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
