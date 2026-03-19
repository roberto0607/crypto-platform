FROM node:20-alpine
WORKDIR /app
RUN npm install -g pnpm@latest
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build
RUN npm install -g serve
EXPOSE 3000
CMD ["sh", "-c", "serve -s dist --listen tcp://0.0.0.0:${PORT:-3000}"]
