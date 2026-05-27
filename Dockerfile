FROM nginx:alpine

# Remove default nginx static content
RUN rm -rf /usr/share/nginx/html/*

# Copy app files
COPY index.html /usr/share/nginx/html/
COPY manifest.json /usr/share/nginx/html/
COPY sw.js /usr/share/nginx/html/
COPY icon-192.svg /usr/share/nginx/html/
COPY icon-512.svg /usr/share/nginx/html/

# Copy nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
