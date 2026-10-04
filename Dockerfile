FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/stride.db
EXPOSE 3000
CMD ["node", "server.js"]
