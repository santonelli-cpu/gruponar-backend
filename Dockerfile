FROM node:22-bookworm-slim

# LibreOffice (genera los PDF de KYC/escrow/contrato desde los .docx
# llenados), unzip/zip (el motor de llenado edita el .docx como un ZIP) y
# poppler-utils/pdfinfo (cuenta páginas del PDF final para poner las
# iniciales de las partes en cada hoja del contrato) — ver README, sección
# "Correrlo en tu máquina".
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice \
      unzip \
      zip \
      python3 \
      poppler-utils \
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
