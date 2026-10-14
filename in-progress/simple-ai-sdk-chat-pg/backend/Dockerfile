# Build from the project root: docker build -f backend/Dockerfile .
FROM oven/bun:1.4.0
WORKDIR /app
COPY package.json bun.lock ./
COPY backend/package.json backend/package.json
COPY shared/package.json shared/package.json
COPY frontend/package.json frontend/package.json
RUN bun install --frozen-lockfile --filter @app/backend
COPY shared shared
COPY backend/src backend/src
COPY backend/drizzle backend/drizzle
COPY backend/drizzle.config.ts backend/tsconfig.json backend/
WORKDIR /app/backend
EXPOSE 4100
# Migrations run before serving; secrets come from the runtime environment.
CMD ["sh", "-c", "bunx drizzle-kit migrate && bun src/server.ts"]
