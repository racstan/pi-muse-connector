# Pi Muse Connector — runs Pi in a container as a non-root user.
# Pi version pinned to the version smoke-tested on the dev VM.
FROM node:20-slim

RUN npm i -g @earendil-works/pi-coding-agent@0.87.1

RUN useradd -m pirunner
USER pirunner
WORKDIR /app

COPY --chown=pirunner:pirunner server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY --chown=pirunner:pirunner server/ ./server/
COPY --chown=pirunner:pirunner openapi.json llms.txt ./

EXPOSE 3000
ENV PORT=3000
CMD ["node", "server/index.js"]
