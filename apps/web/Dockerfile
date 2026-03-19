FROM node:20-alpine
WORKDIR /app
RUN npm install -g pnpm@latest
COPY package.json ./
RUN pnpm install --no-frozen-lockfile
COPY . .
RUN pnpm build
RUN npm install -g serve
EXPOSE 3000
CMD ["serve", "-s", "dist", "-p", "3000"]
