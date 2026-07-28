# Colyseus arena server — plain CommonJS, no build step. Pinned to the
# colyseus@0.16 line to match the vendored browser client (see CLAUDE.md's
# version-pin note); keep this image's Node version in step with whatever
# that dependency line supports.
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 2567

CMD ["node", "index.js"]
