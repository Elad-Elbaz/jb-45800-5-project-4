# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: full dependency tree, TypeScript compiled to dist/.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Manifests first, sources second. Dependencies change far less often than
# code, so this ordering lets every rebuild that only touched src/ reuse the
# cached install layer instead of downloading the tree again.
COPY package.json package-lock.json ./
# `ci` rather than `install`: it installs exactly the lockfile, and fails
# instead of silently resolving something newer.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: production dependencies and compiled output only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json ./
# No TypeScript, no tsx, no type packages in the shipped image: they are build
# tooling, and every one of them is additional surface for no runtime benefit.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The official image ships this unprivileged user. Nothing here writes to disk,
# so root would be a capability the process has no use for.
USER node

EXPOSE 5000

# Node 22 has fetch built in, so this needs no curl or wget in the image.
# It probes liveness only -- /health deliberately does not touch Postgres, or
# a database blip would make Docker restart a healthy API.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:5000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so node is PID 1 and receives SIGTERM directly. Wrapped in a
# shell it would not, and the graceful shutdown in server.ts would never run.
CMD ["node", "dist/server.js"]
