# Stream Bingo. No build step and no dependencies.
FROM node:22-alpine
WORKDIR /app
COPY . .
# Everything the site saves (settings, cards, points, background) lives in /data. Mount a volume there.
ENV DATA_DIR=/data PORT=3000 NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
CMD ["node", "server.js"]
