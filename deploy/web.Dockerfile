FROM node:22-alpine AS build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# The browser companion imports the native companion contract as types.
COPY mobile/src/contracts.ts /build/mobile/src/contracts.ts
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /build/frontend/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
