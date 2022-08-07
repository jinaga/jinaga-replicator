FROM node:18-alpine as build

WORKDIR /replicator

COPY package.json .
COPY package-lock.json .
COPY tsconfig.json .
COPY index.ts .
RUN npm ci
RUN npm run build

FROM jinaga/jinaga-postgres-fact-keystore

WORKDIR /replicator

RUN apk add --no-cache nodejs npm

COPY --from=build /replicator/package.json .
COPY --from=build /replicator/package-lock.json .
COPY --from=build /replicator/dist/ .

ENV NODE_ENV production

RUN npm ci

ENV POSTGRES_PASSWORD adminpw
ENV APP_USERNAME repl
ENV APP_PASSWORD replpw
ENV APP_DATABASE replicator

RUN apk add --update nodejs npm

COPY --from=build /replicator .

COPY start.sh /usr/local/bin/start.sh

ENTRYPOINT [ "start.sh" ]