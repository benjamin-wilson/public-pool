<div align="center">

# Public Pool

**An open source, self-hostable Bitcoin solo mining pool.**

A NestJS and TypeScript Stratum V1 mining server. Point your miner at it and, if it finds a block, the reward goes straight to your own Bitcoin address.

[![License](https://img.shields.io/github/license/benjamin-wilson/public-pool)](LICENSE.txt)
[![Stars](https://img.shields.io/github/stars/benjamin-wilson/public-pool?style=flat)](https://github.com/benjamin-wilson/public-pool/stargazers)
[![Forks](https://img.shields.io/github/forks/benjamin-wilson/public-pool?style=flat)](https://github.com/benjamin-wilson/public-pool/network/members)
[![Issues](https://img.shields.io/github/issues/benjamin-wilson/public-pool)](https://github.com/benjamin-wilson/public-pool/issues)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12.0-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com)
[![Container](https://img.shields.io/badge/ghcr.io-public--pool-2496ED?logo=docker&logoColor=white)](https://github.com/benjamin-wilson/public-pool/pkgs/container/public-pool)

[Live instance](https://web.public-pool.io) · [Web interface](https://github.com/benjamin-wilson/public-pool-ui) · [Report a bug](https://github.com/benjamin-wilson/public-pool/issues)

</div>

---

## Description

A Nestjs and Typescript Bitcoin stratum mining server.

Public Pool connects to your own Bitcoin Core node, builds block templates from it, and serves them to miners over Stratum V1. It is small enough to run on a Raspberry Pi alongside a node, and is commonly used with low-power miners such as the Bitaxe.

### How payouts work

This is a **solo** pool. The coinbase transaction pays the address the miner authenticated with, so a miner that solves a block receives the full block reward directly from the network. There is no pool wallet holding your funds and no payout threshold.

If the operator sets `DEV_FEE_ADDRESS`, a 1.5% share is added to the coinbase for that address. That fee is **automatically waived for miners hashing below 50 TH/s**, and it is never applied when `DEV_FEE_ADDRESS` is unset.

## Features

- **Stratum V1 server** with subscribe, authorize, configure, submit and suggest-difficulty handling
- **Solo payouts** — the block reward goes to the miner's own address
- **Per-client difficulty** tracking and adjustment
- **Bitcoin Core integration** over JSON-RPC, with optional ZMQ for instant new-block notifications
- **REST API** for pool, network, worker and hash-rate chart data
- **Persistent statistics** in SQLite via TypeORM — workers, sessions, best difficulty, found blocks
- **Notifications** — optional Telegram and Discord bots
- **Mainnet, testnet and regtest** support
- **Multi-arch container images** published to GHCR, plus a bundled Bitcoin Core setup

## Tech stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js `>=22.12.0` |
| Framework | NestJS 11 on Fastify |
| Language | TypeScript 5 |
| Database | SQLite via TypeORM |
| Bitcoin | `bitcoinjs-lib`, `tiny-secp256k1`, `merkle-lib`, JSON-RPC, ZeroMQ |
| Testing | Jest |
| Container | Docker, Docker Compose |

## Requirements

- **Node.js `22.12.0` or newer**
- **A synced Bitcoin Core node** with RPC enabled and reachable from the pool

If you do not already run a node, [`full-setup/`](full-setup/) provides a Docker Compose stack that runs Bitcoin Core and Public Pool together.

## Installation

```bash
$ npm install
```

create an new .env file in the root directory and configure it with the parameters in .env.example

```bash
$ cp .env.example .env
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production build
$ npm run build
```

After building, the compiled server is started with `npm run start:prod`.

## Configuration

All configuration is read from `.env` in the project root. See [`.env.example`](.env.example) for the full annotated list.

### Bitcoin node

| Variable | Default | Description |
| --- | --- | --- |
| `BITCOIN_RPC_URL` | — | URL of your Bitcoin node, e.g. `http://192.168.1.100`. Use `http://host.docker.internal` for a node on the Docker host. |
| `BITCOIN_RPC_USER` | — | RPC username. |
| `BITCOIN_RPC_PASSWORD` | — | RPC password. |
| `BITCOIN_RPC_COOKIEFILE` | — | Path to Bitcoin Core's `.cookie` file. Use instead of user and password. |
| `BITCOIN_RPC_PORT` | `8332` | RPC port. |
| `BITCOIN_RPC_TIMEOUT` | `10000` | RPC timeout in milliseconds. |
| `BITCOIN_ZMQ_HOST` | — | Optional ZMQ endpoint for instant block notifications, e.g. `tcp://192.168.1.100:3000`. Requires `zmqpubrawblock=tcp://*:3000` in `bitcoin.conf`. |

### Pool

| Variable | Default | Description |
| --- | --- | --- |
| `STRATUM_PORT` | `3333` | Port miners connect to. |
| `API_PORT` | `3334` | Port the REST API listens on. |
| `STRATUM_MAX_CONNECTIONS_PER_LISTENER` | `10000` | Maximum Stratum connections per worker process, per port. |
| `NETWORK` | `mainnet` | `mainnet`, `testnet` or `regtest`. |
| `POOL_IDENTIFIER` | `"Public-Pool"` | Tag placed in the coinbase script. Removed automatically if it would make the block or coinbase script too big. |
| `DEV_FEE_ADDRESS` | — | Optional. When set, adds a 1.5% coinbase output, waived below 50 TH/s. |
| `API_SECURE` | `false` | Serve the API over HTTPS using `secrets/key.pem` and `secrets/cert.pem`. |

### Notifications

| Variable | Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Optional Telegram bot token. |
| `DISCORD_BOT_CLIENTID` | Optional Discord bot client ID. |
| `DISCORD_BOT_GUILD_ID` | Optional Discord guild ID. |
| `DISCORD_BOT_CHANNEL_ID` | Optional Discord channel ID. |

## Connecting a miner

Point your miner at the Stratum port and use your **Bitcoin address as the username**, optionally suffixed with a worker name:

```
URL:      stratum+tcp://<your-pool-host>:3333
Username: <your BTC address>.<worker name>
Password: x
```

The address is validated on authorization, so it must be valid for the configured `NETWORK`.

## API

The REST API listens on `API_PORT` (default `3334`).

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/info` | Found blocks, connected user agents, high scores and server uptime. |
| `GET` | `/info/chart` | Site-wide hash-rate chart data. |
| `GET` | `/pool` | Total hash rate, total miners, current block height, blocks found. |
| `GET` | `/network` | Bitcoin network mining info from the node. |
| `GET` | `/client/:address` | Best difficulty and all workers for an address. |
| `GET` | `/client/:address/chart` | Hash-rate chart data for an address. |
| `GET` | `/client/:address/:workerName` | Best difficulty and chart data for a named worker. |
| `GET` | `/client/:address/:workerName/:sessionId` | Detail for a single worker session. |
| `GET` | `/share/top-difficulties` | Highest difficulty shares recorded. |

## Test

```bash
# unit tests
$ npm run test

# test coverage
$ npm run test:cov
```

## Web interface

See [public-pool-ui](https://github.com/benjamin-wilson/public-pool-ui)

A public instance of the pool and its web interface is available at [web.public-pool.io](https://web.public-pool.io).

## Deployment

Install pm2 (https://pm2.keymetrics.io/)

```bash
$ pm2 start dist/main.js
```

When running the worker app in PM2 cluster mode, start the PM2 daemon with OS-level
connection scheduling. The environment variable must be present when the PM2 daemon
starts, not only in the worker configuration.

```bash
$ NODE_CLUSTER_SCHED_POLICY=none pm2 start ecosystem.config.js
```

> **Note:** `ecosystem.config.js` is not included in this repository. Create your own
> [PM2 ecosystem file](https://pm2.keymetrics.io/docs/usage/application-declaration/)
> pointing at `dist/main.js` to use cluster mode.

Cluster-mode connection dropping requires Node.js `22.12.0` or newer.

`STRATUM_MAX_CONNECTIONS_PER_LISTENER` is enforced per worker and Stratum port.
Size it using the busiest port: `worker count * limit`. For example, 28 workers
with the default limit of `10000` allow up to `280000` connections on one port.

## Docker

A prebuilt multi-arch image is published on every push to `master`:

```bash
$ docker pull ghcr.io/benjamin-wilson/public-pool:latest
```

Build container:

```bash
$ docker build -t public-pool .
```

Run container:

```bash
$ docker container run --name public-pool --rm -p 3333:3333 -p 3334:3334 -p 8332:8332 -v .env:/public-pool/.env public-pool
```

### Docker Compose

Build container:
```bash
$ docker compose build
```

Run container:
```bash
$ docker compose up -d
```

The docker-compose binds to `127.0.0.1` by default. To expose the Stratum services on your server change:
```diff
    ports:
-      - "127.0.0.1:3333:3333/tcp"
-      - "127.0.0.1:3334:3334/tcp"
+      - "3333"
+      - "3334"
```

**note**: To successfully connect to the bitcoin RPC you will need to add

```
rpcallowip=172.16.0.0/12
```

to your bitcoin.conf.

### Bitcoin Core included

[`full-setup/`](full-setup/) contains Docker Compose stacks that run Bitcoin Core and Public Pool together for mainnet, testnet or regtest, including ready-made `bitcoin.conf` files. See [`full-setup/README.md`](full-setup/README.md) for instructions.

## Contributing

Issues and pull requests are welcome.

```bash
$ npm run lint     # eslint with --fix
$ npm run format   # prettier
$ npm run test     # jest
```

Please run the tests before opening a pull request.

## License

Released under the [GNU General Public License v3.0](LICENSE.txt).
