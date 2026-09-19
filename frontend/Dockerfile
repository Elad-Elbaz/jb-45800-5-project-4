# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: type-check and bundle.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./
COPY vite.config.ts index.html ./
COPY src ./src

# `npm run build` is `tsc -b && vite build`, so a type error fails the image
# build rather than shipping a bundle that was never checked.
RUN npm run build

# ---------------------------------------------------------------------------
# Runtime stage: static files behind nginx.
#
# Node is absent from the final image entirely. The output is HTML, CSS and
# JavaScript; serving it from a Node process would mean shipping a runtime,
# a dependency tree and a event loop to do what nginx does natively.
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
