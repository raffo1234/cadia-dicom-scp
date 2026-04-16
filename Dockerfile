FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y dcmtk proxychains4 && rm -rf /var/lib/apt/lists/*
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn tsc --build
EXPOSE 11112 3001
COPY entrypoint.sh ./
CMD ["./entrypoint.sh"]
