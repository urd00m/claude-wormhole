FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv util-linux e2fsprogs git ca-certificates curl tini procps jq sqlite3 iptables && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /opt/analysis && /opt/analysis/bin/pip install --no-cache-dir numpy pandas matplotlib scipy duckdb
RUN npm install --global @openai/codex@0.162.1 @anthropic-ai/claude-code@2.1.154
WORKDIR /opt/wormhole
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY dist/ ./dist/
RUN chmod -R a+rX /opt/wormhole
ENV PATH="/opt/analysis/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME=/user/home WORMHOLE_WORKER=1 WORMHOLE_STATE_DIR=/user/state CODEX_HOME=/user/codex CLAUDE_CONFIG_DIR=/user/claude DEFAULT_RUNTIME=codex CONTEXT_INDICATOR=off
USER 1000:1000
WORKDIR /user
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
