FROM node:22-slim

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Expose Gateway port
EXPOSE 18789

# Health check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:18789/health || exit 1

CMD ["node", "dist/cli/index.js", "start"]
