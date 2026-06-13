# Nano Claude Code runner — Node + git + Claude Code CLI
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI (headless via ANTHROPIC_API_KEY)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY package.json ./
COPY agent-sdk ./agent-sdk

ENV NANO_URL=https://nano.lakshyashishir1.workers.dev
ENV RUNNER_WAKE_PORT=8080

EXPOSE 8080

CMD ["node", "agent-sdk/examples/claude-code-adapter.js"]
