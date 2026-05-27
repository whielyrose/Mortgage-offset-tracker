FROM node:22-alpine

WORKDIR /app

# Build tools needed for better-sqlite3 (native C++ module used by @actual-app/api)
RUN apk add --no-cache python3 make g++ tzdata

# Install dependencies
COPY package.json .
RUN npm install --production

COPY sync.js .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Cache directory for Actual Budget data
RUN mkdir -p /tmp/actual-cache

# Default timezone — override by setting TZ in your compose environment
ENV TZ=Australia/Brisbane

ENTRYPOINT ["sh", "entrypoint.sh"]
