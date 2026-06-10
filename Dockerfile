FROM node:22-alpine

RUN apk upgrade --no-cache

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 7000

CMD ["node", "index.js"]
