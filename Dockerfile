FROM node:20-alpine

WORKDIR /app

# Copiamos archivos de configuración, lockfile y el nuevo workspace que autoriza esbuild
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN npm install -g pnpm \
    && pnpm install --no-frozen-lockfile

# Copiamos el resto del código fuente
COPY . .

# Compilamos TypeScript
RUN pnpm build

ENV PORTALV4_ROOT=/app/portalv4

CMD ["node", "dist/index.js"]