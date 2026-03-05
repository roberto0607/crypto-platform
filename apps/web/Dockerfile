# ── Stage 1: Build ──
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.30.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm build

# ── Stage 2: Serve with nginx ──
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist/ /usr/share/nginx/html/
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
