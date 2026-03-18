FROM node:20-alpine
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
RUN pnpm install --frozen-lockfile
COPY apps/api/ ./apps/api/
RUN pnpm --filter api build
WORKDIR /app/apps/api
EXPOSE 3001
CMD ["node", "dist/server.js"]
