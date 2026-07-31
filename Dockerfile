# syntax=docker/dockerfile:1.7
FROM node:22.22.0-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json eslint.config.mjs ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22.22.0-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S -g 10001 hollowcon && adduser -S -D -H -u 10001 -G hollowcon hollowcon
COPY --from=build --chown=hollowcon:hollowcon /app/node_modules ./node_modules
COPY --from=build --chown=hollowcon:hollowcon /app/apps ./apps
COPY --from=build --chown=hollowcon:hollowcon /app/packages ./packages
COPY --from=build --chown=hollowcon:hollowcon /app/package.json /app/pnpm-workspace.yaml ./
USER hollowcon

FROM runtime AS api
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS web
EXPOSE 3001
CMD ["node", "apps/web/dist-server/index.js"]

FROM runtime AS bot
EXPOSE 3002
CMD ["node", "apps/bot/dist/index.js"]

FROM runtime AS worker
EXPOSE 3003
CMD ["node", "apps/worker/dist/index.js"]

FROM build AS migrate
CMD ["./packages/database/node_modules/.bin/prisma", "migrate", "deploy", "--schema", "packages/database/prisma/schema.prisma"]
