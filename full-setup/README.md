# Full Setup for public pool

This setup provides Docker Compose stacks for Bitcoin Core, Public Pool,
TimescaleDB, and Redis on mainnet, testnet, and regtest.

It exposes following ports:

- `8332/18332` Bitcoin RPC on `localhost`
- `8333/18333` Bitcoin peering on `0.0.0.0`
- `3333/13333` Public-Pool Stratum port on `0.0.0.0`
- `3334/13334` Public-Pool API port on `localhost`
- TimescaleDB and Redis only on the internal compose network

The docker-compose setups for Mainnet and Testnet can be run in parallel without any problems.

# Building Images

The images are built with

```
docker compose -f docker-compose-mainnet.yml build
```

Instead of `-mainnet` you can use `-testnet` for Testnet

# Preparing directories

Before starting the setup, directories need to be created.

```
sudo ./prepare.sh
```

# Config files

There are 4 config files for Mainnet and Testnet

`mainnet`:
- `public-pool-mainnet.env`
- `bitcoin-mainnet.conf`

`testnet`:
- `public-pool-testnet.env`
- `bitcoin-testnet.conf`

**note: pruning (`prune=550`) is enabled by default in the config**
**note: Bitcoin ZMQ raw block publishing is enabled on the internal compose
network so the Public Pool master can refresh templates immediately after new
blocks.**
# Running the setup

To start the setup in foreground mode:

```
docker compose -f docker-compose-mainnet.yml up
```

To run the setup in detached / background mode use `up -d`.

In detached mode logs can be watched with:
```
docker compose -f docker-compose-mainnet.yml logs --tail 100 -f
```

# Stopping the setup

To stop the setup use:

```
docker compose -f docker-compose-mainnet.yml down
```

Database and Redis data are stored under `full-setup/data/<network>/`. To remove
all runtime data, stop the stack and delete the relevant `bitcoin`,
`timescaledb`, and `redis` directories.

# Migrations and backups

The Public Pool container waits for TimescaleDB and Redis, runs migrations, and
then starts PM2. To run migrations manually:

```bash
docker compose -f docker-compose-mainnet.yml run --rm public-pool npm run migration:run:prod
```

To back up mainnet accounting data:

```bash
docker compose -f docker-compose-mainnet.yml exec timescaledb pg_dump -U public_pool public_pool_mainnet > public-pool-mainnet.sql
```

# Regtest

After running the `regtest` setup a couple of blocks need to be generated:

```bash
# create wallet
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest createwallet "regtestwallet"

# generate 101 blocks
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest  -generate 101
```
