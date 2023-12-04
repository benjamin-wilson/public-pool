# Full Setup for public pool

This setup provides a docker-compose setup consisting of Bitcoin Core Node and Public-Pool running in Mainnet or Testnet.

It exposes following ports:

- `8332/18332` Bitcoin RPC on `localhost`
- `8333/18333` Bitcoin peering on `0.0.0.0`
- `3333/13333` Public-Pool Stratum port on `0.0.0.0`
- `3334/13334` Public-Pool API port on `localhost`

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

# Regtest

After running the `regtest` setup a couple of blocks need to be generated:

```bash
# create wallet
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest createwallet "regtestwallet"

# generate 101 blocks
$ docker exec -it  bitcoin-regtest /app/bin/bitcoin-cli -conf=/app/data/bitcoin.conf -regtest  -generate 101
```
