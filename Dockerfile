FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

RUN yarn tsc --build

EXPOSE 11112 3001

CMD ["node", "dist/server.js"]