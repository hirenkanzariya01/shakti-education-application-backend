# Shakti API for Google Cloud Run (also runs anywhere Docker does).
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Run as the unprivileged "node" user that ships with the image.
USER node
# Cloud Run injects PORT (8080); the app reads it. Secrets come from environment variables / Secret Manager, never from the image.
EXPOSE 8080
ENV PORT=8080
CMD ["node", "src/server.js"]
