FROM node:22-slim

# Install Chromium + fonts (needed for Puppeteer PDF generation)
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use system Chromium instead of downloading its own
ENV TZ=Asia/Kolkata \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install dependencies first (separate layer — faster rebuilds)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure data directory exists (will be overlaid by Railway persistent volume)
RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "--no-warnings", "--experimental-sqlite", "server.js"]
