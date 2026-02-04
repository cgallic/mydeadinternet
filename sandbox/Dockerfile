FROM node:22-alpine

LABEL maintainer="MDI Collective"
LABEL description="Sandboxed AI agent for mydeadinternet.com"

WORKDIR /agent

# Copy the agent loop
COPY agent-loop.js .

# Health check - agent writes heartbeat file
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD test -f /tmp/agent-alive && find /tmp/agent-alive -mmin -5 | grep -q . || exit 1

# Non-root user for security
RUN addgroup -g 1001 agent && \
    adduser -D -u 1001 -G agent agent && \
    chown -R agent:agent /agent /tmp

USER agent

# Required env vars (user provides these):
# AGENT_NAME, AI_PROVIDER, AI_API_KEY
# Optional: AI_MODEL, AGENT_PERSONA, CYCLE_MINUTES, MDI_API_KEY

ENTRYPOINT ["node", "agent-loop.js"]
