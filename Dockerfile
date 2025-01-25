FROM node:18-alpine AS build

WORKDIR /replicator

COPY package.json .
COPY package-lock.json .
COPY tsconfig.json .
COPY *.ts .
RUN npm ci
RUN npm run build

FROM jinaga/jinaga-postgres-fact-keystore:5.3.0

WORKDIR /replicator

RUN apk add --no-cache nodejs npm

COPY --from=build /replicator/package.json .
COPY --from=build /replicator/package-lock.json .
COPY --from=build /replicator/dist/ .

ENV NODE_ENV=production

RUN npm ci

ENV POSTGRES_PASSWORD=adminpw
ENV APP_USERNAME=repl
ENV APP_PASSWORD=replpw
ENV APP_DATABASE=replicator

RUN apk add --update nodejs npm

COPY --from=build /replicator .

COPY start.sh /usr/local/bin/start.sh

RUN mkdir -p /var/lib/replicator/policies
VOLUME /var/lib/replicator/policies

ENV JINAGA_POLICIES=/var/lib/replicator/policies

RUN mkdir -p /var/lib/replicator/authentication
VOLUME /var/lib/replicator/authentication

ENV JINAGA_AUTHENTICATION=/var/lib/replicator/authentication

RUN mkdir -p /var/lib/replicator/subscriptions
VOLUME /var/lib/replicator/subscriptions

ENV JINAGA_SUBSCRIPTIONS=/var/lib/replicator/subscriptions

ENTRYPOINT [ "start.sh" ]