FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm@latest

# Install dependencies
COPY package.json ./
RUN pnpm install --no-frozen-lockfile

# Copy source + migrations
COPY tsconfig.json ./
COPY src/ ./src/
COPY migrations/ ./migrations/

# Build TypeScript
RUN pnpm build

# Runtime
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/server.js"]
