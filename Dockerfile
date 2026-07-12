# Omnicord container image. Runs the Streamable HTTP transport as a
# non-root user. The server refuses to start on a non-loopback bind
# without OMNICORD_HTTP_TOKEN, so a container with no token set fails
# fast with a clear message instead of exposing the bot.

FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-alpine
RUN addgroup -S omnicord && adduser -S omnicord -G omnicord
WORKDIR /app
ENV NODE_ENV=production \
    OMNICORD_HTTP_HOST=0.0.0.0 \
    OMNICORD_PORT=3414
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER omnicord
EXPOSE 3414
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3414/healthz || exit 1
CMD ["node", "dist/index.js", "--http"]
