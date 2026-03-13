FROM node:20-alpine

# Install build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy server package files
COPY server/package*.json ./server/

# Install server dependencies
WORKDIR /app/server
RUN npm install --production

# Copy all source files
WORKDIR /app
COPY server/ ./server/
COPY mini-app/ ./mini-app/

# Set working directory to server
WORKDIR /app/server

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "index.js"]
