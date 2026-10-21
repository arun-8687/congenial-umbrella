# Copilot Bots: production image.
# Runs as an unprivileged user with state in /data (mode 0700). Recommended:
#   docker run --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
#     -v bots-data:/data -e SECRET_KEY=... -e PUBLIC_URL=https://bots.example.com copilot-bots
# The shared computer is off by default. COMPUTER_ACCESS=shell additionally requires
# COMPUTER_SHELL_ISOLATED=1, which you should only set when each user's runtime is isolated.
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
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/cli.js", "serve"]
