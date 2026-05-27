FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json .
RUN npm install --production

COPY sync.js .

# Cache directory for Actual Budget data
RUN mkdir -p /tmp/actual-cache

CMD ["node", "sync.js"]
