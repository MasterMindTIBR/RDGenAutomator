# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json

FROM base AS dependencies
RUN pnpm install --frozen-lockfile

FROM dependencies AS source
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

FROM source AS web-build
RUN pnpm --filter @rdgen/web build

FROM base AS runtime-base
ENV NODE_ENV=production

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=source /app/tsconfig.base.json ./
COPY --from=source /app/apps ./apps
COPY --from=source /app/packages ./packages

FROM runtime-base AS api
EXPOSE 3001
CMD ["pnpm", "--filter", "@rdgen/api", "start"]

FROM runtime-base AS worker
EXPOSE 3002
CMD ["pnpm", "--filter", "@rdgen/worker", "start"]

FROM runtime-base AS web
COPY --from=web-build /app/apps/web/.output ./apps/web/.output
EXPOSE 3000
CMD ["pnpm", "--filter", "@rdgen/web", "start"]
