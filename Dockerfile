############################
# Docker build environment #
############################

FROM node:18.16.1-bookworm AS build

WORKDIR /build

COPY . .

RUN npm i
RUN npm run build

############################
# Docker final environment #
############################

FROM node:18.16.1-bookworm

EXPOSE 3333
EXPOSE 3334
EXPOSE 8332

WORKDIR /public-pool

COPY --from=build /build .
#COPY .env.example .env

CMD ["/usr/local/bin/node", "dist/main"]
