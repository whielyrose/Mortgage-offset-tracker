FROM node:20-alpine

WORKDIR /app

# Build tools needed for better-sqlite3 (native C++ module used by @actual-app/api)
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package.json .
RUN npm install --production

COPY sync.js .

# Cache directory for Actual Budget data
RUN mkdir -p /tmp/actual-cache

CMD ["node", "sync.js"]
