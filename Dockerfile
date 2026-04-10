# Playwright resmi Docker image — Chromium dahil
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Bağımlılıkları kur
COPY package.json ./
RUN npm install

# Kaynak kodu kopyala
COPY server.js ./

# Playwright tarayıcılarını indir
RUN npx playwright install chromium

# Port
EXPOSE 3000

# Başlat
CMD ["node", "server.js"]
