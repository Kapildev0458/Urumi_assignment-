# Build: docker build -t localhost:5000/urumi/dashboard:<tag> apps/dashboard
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# Unprivileged nginx: runs as uid 101 on port 8080 and writes only to /tmp.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
