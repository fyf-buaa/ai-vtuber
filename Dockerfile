FROM node:22.19.0-bookworm-slim AS build

WORKDIR /workspace
COPY pi/ ./pi/
RUN npm --prefix ./pi ci --ignore-scripts

COPY package.json package-lock.json tsconfig.json tsconfig.build.json LICENSE ./
COPY src/ ./src/
COPY web/ ./web/
COPY Live2D/ ./Live2D/
RUN npm ci --ignore-scripts
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts \
    && npm --prefix ./pi prune --omit=dev --ignore-scripts

FROM node:22.19.0-bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /workspace/app

COPY --from=build --chown=node:node /workspace/pi/package.json /workspace/pi/package-lock.json /workspace/pi/LICENSE /workspace/pi/.source.json ./pi/
COPY --from=build --chown=node:node /workspace/pi/node_modules/ ./pi/node_modules/
COPY --from=build --chown=node:node /workspace/pi/packages/agent/package.json ./pi/packages/agent/package.json
COPY --from=build --chown=node:node /workspace/pi/packages/agent/dist/ ./pi/packages/agent/dist/
COPY --from=build --chown=node:node /workspace/pi/packages/ai/package.json ./pi/packages/ai/package.json
COPY --from=build --chown=node:node /workspace/pi/packages/ai/dist/ ./pi/packages/ai/dist/
COPY --from=build --chown=node:node /workspace/pi/packages/telemetry/package.json ./pi/packages/telemetry/package.json
COPY --from=build --chown=node:node /workspace/pi/packages/telemetry/dist/ ./pi/packages/telemetry/dist/

COPY --from=build --chown=node:node /workspace/package.json /workspace/package-lock.json /workspace/LICENSE ./
COPY --from=build --chown=node:node /workspace/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /workspace/dist/ ./dist/
COPY --from=build --chown=node:node /workspace/web/ ./web/
COPY --from=build --chown=node:node /workspace/Live2D/ ./Live2D/

USER root
RUN mkdir -p /state data out log \
    && chown -R node:node /state /workspace/app
USER node

VOLUME ["/state", "/workspace/app/data", "/workspace/app/out", "/workspace/app/log"]
EXPOSE 8081 8082 12345

CMD ["node", "--enable-source-maps", "dist/index.js", "--config", "/state/config.local.json", "--no-stdin"]
