# Portable build — runs the same on Railway, Render, Fly, a VPS, or locally.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

EXPOSE 8080
CMD ["node", "server/src/index.js"]
