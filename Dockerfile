FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y dcmtk && rm -rf /var/lib/apt/lists/*

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

RUN yarn tsc --build

EXPOSE 11112 3001

CMD ["node", "dist/server.js"]