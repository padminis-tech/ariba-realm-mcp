# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first (layer cache — only re-runs if package.json changes)
COPY package.json ./
RUN npm install --omit=dev

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

WORKDIR /app

# Copy installed modules and server code
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server/ ./server/

# Non-root user for security
RUN addgroup -S ariba && adduser -S ariba -G ariba
USER ariba

EXPOSE 3000

# Health check — Kyma liveness probe hits /health
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["node", "server/index.js"]
