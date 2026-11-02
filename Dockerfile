############################
# Docker build environment #
############################

FROM node:24.16.0-bookworm-slim AS build

# Upgrade all packages and install dependencies
RUN apt-get update \
    && apt-get upgrade -y
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        cmake \
        curl \
        ca-certificates \
    && apt clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

WORKDIR /build

COPY . .

# Build Public Pool using NPM
RUN npm i && npm run build

############################
# Docker final environment #
############################

FROM node:24.16.0-bookworm-slim

# Expose ports for Stratum and Bitcoin RPC
EXPOSE 3333 3334 8332

WORKDIR /public-pool

# Copy built binaries into the final image
COPY --from=build /build .
#COPY .env.example .env

# Run as the non-root `node` user (uid/gid 1000) built into the node base
# image. The app's only writable state is the SQLite directory (./DB,
# created relative to the workdir); pre-create it owned by node so fresh
# named volumes are writable out of the box (Docker copies image contents
# into empty named volumes) and host bind mounts can be chowned to
# 1000:1000. No port below 1024 is bound, so no capabilities are needed.
RUN mkdir -p /public-pool/DB && chown node:node /public-pool/DB
USER node

CMD ["/usr/local/bin/node", "dist/main"]
