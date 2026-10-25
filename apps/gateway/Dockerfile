# Build: docker build -t localhost:5000/urumi/gateway:<tag> apps/gateway
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Numeric uid so Kubernetes runAsNonRoot can verify it (the image's "node" user).
USER 1000:1000
EXPOSE 3000
CMD ["node", "dist/server.js"]
