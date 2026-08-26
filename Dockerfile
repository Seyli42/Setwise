# Dockerfile pour Setwise (Deno + Neon Backend)
FROM denoland/deno:2.1.0

WORKDIR /app

# Met en cache les dépendances
COPY deno.json deno.lock* ./
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/
COPY frontend/ ./frontend/

RUN deno cache src/server.ts scripts/migrate.ts

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "src/server.ts"]
