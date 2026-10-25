# Build: docker build -t localhost:5000/urumi/notes-mcp:<tag> apps/notes-mcp
# ===== Stage 1: the kitchen (build the code) =====
FROM node:20-alpine AS build
WORKDIR /app

# Copy the shopping list and download the libraries   (= your Step 3)
COPY package.json package-lock.json ./
RUN npm ci

# Copy the code and translate it                      (= your Step 5)
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Throw away the translator; keep only runtime libraries
RUN npm prune --omit=dev

# ===== Stage 2: the box (only what is needed to run) =====
FROM node:20-alpine
WORKDIR /app

# Take only the finished things from the kitchen
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# A folder for notes.json, owned by a normal (non-admin) user
RUN mkdir /data && chown 1000:1000 /data
ENV NOTES_FILE=/data/notes.json PORT=3000

# Run as that normal user, not as admin
USER 1000:1000
EXPOSE 3000

# What runs when the container starts                 (= your npm start)
CMD ["node", "dist/server.js"]
