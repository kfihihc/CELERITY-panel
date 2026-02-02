# Hysteria Backend - Docker Image
FROM node:20-alpine

WORKDIR /app

# Install system dependencies (mongodump for backups)
RUN apk add --no-cache mongodb-tools

# Copy dependencies
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy source files
COPY . .

# Create directories for logs, certificates, and backups
RUN mkdir -p logs greenlock.d/live greenlock.d/accounts backups && \
    chmod -R 755 greenlock.d backups

# Ports
EXPOSE 8444 80 443

# Start
CMD ["node", "index.js"]
