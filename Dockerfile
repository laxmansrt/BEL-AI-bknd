# ── Stage 1: Install dependencies ────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# Copy manifests first for layer caching
COPY package.json package-lock.json ./

# Install production deps only
RUN npm ci --omit=dev

# ── Stage 2: Final runtime image ──────────────────────────────
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.title="BelAI Backend"
LABEL org.opencontainers.image.description="BELAI Agricultural AI — Express/Node.js API"
LABEL org.opencontainers.image.version="1.0.0"

# Security: run as non-root
RUN addgroup -S belai && adduser -S belai -G belai

WORKDIR /app

# Copy installed modules + source
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=belai:belai . .

# Remove dev artifacts
RUN rm -f .env

USER belai

EXPOSE 4000

# Kubernetes liveness probe endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "server.js"]
