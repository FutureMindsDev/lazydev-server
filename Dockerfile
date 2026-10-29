# Base image
FROM node:20-alpine AS base

# Install necessary system dependencies for building native modules, running
# sandbox tools, and cross-UID worktree cleanup. `acl` lets the unprivileged
# app user delete Serena's root-owned .serena metadata (see WorktreeManager).
RUN apk add --no-cache python3 make g++ git docker-cli ripgrep acl

# Dependencies stage
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# Builder stage
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Runner stage
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy only production dependencies and built files
# NOTE: never COPY *.pem into the image. The GitHub App private key is passed
# as the GITHUB_PRIVATE_KEY env value at runtime — baking a key file into the
# image would leak it to anyone who pulls the image.
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Create the mount points for the named volumes BEFORE the chown below, so
# fresh volumes inherit node ownership (old root-owned volumes need a
# one-time chown — see README §5).
RUN mkdir -p /app/repo-cache /app/worktrees

# Ensure the app runs with appropriate permissions
RUN chown -R node:node /app

# The sandbox agent requires docker access. Depending on the environment, 
# you may need to mount the host's docker socket and run as root or add 'node' to the 'docker' group.
# For maximum safety in production, we will run as the 'node' user by default.
USER node

EXPOSE 3200

# Start the application
CMD ["npm", "run", "start:prod"]
