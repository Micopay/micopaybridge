FROM node:20-alpine AS base
WORKDIR /app

RUN apk add --no-cache curl netcat-openbsd

FROM base AS deps
COPY package*.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package*.json ./
COPY . .

RUN chmod +x entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

ENTRYPOINT ["./entrypoint.sh"]
