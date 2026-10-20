# Copilot Bots: production image.
# Bots with the Computer capability run shell commands inside this container, so run one
# container per trust boundary and mount only what bots should see.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 STATE_DIR=/data WORKSPACE_DIR=/app/workspace
WORKDIR /app
RUN useradd --create-home --uid 10001 bots && mkdir -p /data && chown bots /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
COPY workspace ./workspace
USER bots
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/cli.js", "serve"]
