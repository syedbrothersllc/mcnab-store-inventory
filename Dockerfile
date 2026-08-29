FROM node:20-bookworm-slim

# Install build dependencies for native C++ modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server/server.js"]
