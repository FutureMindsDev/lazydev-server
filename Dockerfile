# Base image
FROM node:20-alpine AS base

# Install necessary system dependencies for building native modules or running sandbox tools
RUN apk add --no-cache python3 make g++ git docker-cli ripgrep

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
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/*.pem ./

# Create necessary directories for local caching and sandbox execution
RUN mkdir -p /app/repositories /app/data

# Ensure the app runs with appropriate permissions
RUN chown -R node:node /app

# The sandbox agent requires docker access. Depending on the environment, 
# you may need to mount the host's docker socket and run as root or add 'node' to the 'docker' group.
# For maximum safety in production, we will run as the 'node' user by default.
USER node

EXPOSE 3200

# Start the application
CMD ["npm", "run", "start:prod"]
