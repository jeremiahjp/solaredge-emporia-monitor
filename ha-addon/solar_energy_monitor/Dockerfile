ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /usr/src/app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY service.js ha-mqtt.js ./

CMD [ "node", "service.js" ]
