FROM node:22-alpine
WORKDIR /app
COPY server.js .
COPY admin ./admin
COPY geoip/ipv4-regions.bin ./geoip/ipv4-regions.bin
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
