FROM node:22-bookworm-slim

# LibreOffice (genera los PDF de KYC/escrow/contrato desde los .docx
# llenados) y unzip/zip (el motor de llenado edita el .docx como un ZIP) —
# ver README, sección "Correrlo en tu máquina".
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice \
      unzip \
      zip \
      python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# El disco persistente de Render se monta aquí (ver render.yaml) — la base
# de datos, las sesiones y los uploads viven todos dentro para sobrevivir
# a un redeploy.
ENV DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 3000
CMD ["node", "server.js"]
