FROM node:20-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN npm ci --ignore-scripts

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production

RUN apk add --no-cache nginx curl

COPY --from=builder /app/dist /var/www/dist
COPY nginx.conf /etc/nginx/http.d/default.conf

EXPOSE 5186

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5186 || exit 1

CMD ["nginx", "-g", "daemon off;"]
