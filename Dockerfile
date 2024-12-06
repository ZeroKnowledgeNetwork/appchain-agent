# Stage 0: Base
FROM node:18-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack install --global pnpm@latest
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app/appchain-agent


# Stage 1: Build
FROM base AS builder

COPY package.json pnpm-lock.yaml ./

COPY --from=context-protokit / /app/protokit
RUN --mount=type=cache,id=npm,target=/root/.npm \
  cd /app/protokit \
  && npm set cache /root/.npm \
  && npm ci \
  && npm run build

COPY --from=context-appchain / /app/appchain
RUN --mount=type=cache,id=pnpm,target=${PNPM_HOME}/store \
  cd /app/appchain/packages/chain \
  && pnpm install --frozen-lockfile \
  && pnpm build

RUN --mount=type=cache,id=pnpm,target=${PNPM_HOME}/store \
  cd /app/appchain-agent \
  && pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build


# Stage 2: Production image
FROM base AS runner

# install deps used by scripts
RUN apk add --no-cache \
  bash \
  netcat-openbsd

COPY --from=builder /app/appchain/packages/chain/dist /app/appchain/packages/chain/dist
COPY --from=builder /app/appchain/packages/chain/package.json /app/appchain/packages/chain/
COPY --from=builder /app/appchain/package.json /app/appchain/pnpm-lock.yaml /app/appchain/
COPY --from=builder /app/appchain-agent/dist ./dist
COPY --from=builder /app/appchain-agent/package.json /app/appchain-agent/pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=${PNPM_HOME}/store pnpm install --prod --frozen-lockfile

COPY bin ./bin

USER node
