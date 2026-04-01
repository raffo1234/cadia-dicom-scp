FROM node:20-alpine

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

RUN yarn global add ts-node typescript

EXPOSE 11112

CMD ["ts-node", "src/server.ts"]