FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY package.json package-lock.json ./
# npm is only needed to install dependencies; drop it so its bundled packages are not shipped.
RUN npm ci --omit=dev && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

COPY --chown=node:node src ./src

USER node

# A one-shot tool: docker compose run --rm analytics <game_uuid> [--save|--apply]
ENTRYPOINT ["node", "src/cli.js"]
