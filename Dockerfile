# syntax=docker/dockerfile:1

# --- Build: Vite client + compiled Express API ---
# Gemini uses GEMINI_API_KEY at runtime (e.g. Cloud Run Secret Manager), not at image build time.
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run build:server

# --- Runtime: production deps + static + server JS ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/backend/dist ./backend/dist

EXPOSE 8080
CMD ["node", "backend/dist/server.js"]
