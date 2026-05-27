FROM node:22-alpine

WORKDIR /app

# Build tools needed for better-sqlite3 (native C++ module used by @actual-app/api)
RUN apk add --no-cache python3 make g++ tzdata

# Set timezone to Brisbane
ENV TZ=Australia/Brisbane
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Install dependencies
COPY package.json .
RUN npm install --production

COPY sync.js .

# Cache directory for Actual Budget data
RUN mkdir -p /tmp/actual-cache

# Clear cache on every run to avoid stale migration state
CMD ["sh", "-c", "rm -rf /tmp/actual-cache/* && node sync.js"]
