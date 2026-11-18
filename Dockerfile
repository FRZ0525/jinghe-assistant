FROM node:24-bookworm-slim

WORKDIR /app
COPY server.js market-quotes.js index.html styles.css app.js tracker.js roster-ocr.js roster-layout.js roster-import.js sync-merge.js sync-client.js market-client.js recovery.js coa-*.webp ./
COPY assets/ ./assets/
COPY ocr/ ./ocr/

RUN mkdir /data && chown node:node /data
USER node
ENV JINGHE_HOST=0.0.0.0
ENV JINGHE_DB_PATH=/data/jinghe.sqlite
CMD ["node", "server.js"]
