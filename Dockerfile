FROM node:20-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package*.json ./
RUN npm ci --production

# Copy source
COPY . .

# Create data directory for persistent stats
RUN mkdir -p data

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "src/server.js"]
