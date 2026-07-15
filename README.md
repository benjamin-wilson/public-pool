## Description

A Nestjs and Typescript Bitcoin stratum mining server.

## Installation

```bash
$ npm install
```

create an new .env file in the root directory and configure it with the parameters in .env.example

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production build
$ npm run build
```

## Test

```bash
# unit tests
$ npm run test

# test coverage
$ npm run test:cov
```

## Web interface

See [public-pool-ui](https://github.com/benjamin-wilson/public-pool-ui)

## Deployment

The production Docker image runs database migrations and then starts PM2
automatically. For a manual host deployment, install pm2
(https://pm2.keymetrics.io/), run migrations, then start the app.

```bash
$ npm run build
$ npm run migration:run:prod
$ pm2 start dist/main.js
```

When running the worker app in PM2 cluster mode, start the PM2 daemon with OS-level
connection scheduling. The environment variable must be present when the PM2 daemon
starts, not only in the worker configuration.

```bash
$ NODE_CLUSTER_SCHED_POLICY=none pm2 start ecosystem.config.js
```

Cluster-mode connection dropping requires Node.js `22.12.0` or newer.

`STRATUM_WORKERS=auto` is the default. It uses the container's available CPU
count after reserving `API_WORKERS` CPUs plus one for the master. A numeric value
still pins an exact topology. Size fixed deployments from the busiest worker,
not just total connection capacity: keep roughly 10,000 or fewer miners per
worker when low new-tip fanout latency matters. The `stratum_job_fanout`
`overTargetClients` field uses `STRATUM_FANOUT_TARGET_CLIENTS_PER_WORKER` to
make an undersized worker tier visible. Pools beyond one host's practical CPU or
socket capacity should shard listeners across multiple worker hosts connected to
the same urgent Redis channel.

`STRATUM_MAX_CONNECTIONS_PER_LISTENER` is enforced per worker and Stratum port.
Size it using the busiest port: `worker count * limit`. For example, 28 workers
with the default limit of `10000` allow up to `280000` connections on one port.

SV2 pool-assigned extranonces reserve the first of their four prefix bytes for
a process namespace and share the remaining 24-bit allocation space across
standard and extended channels. Under PM2, the namespace uses
`NODE_APP_INSTANCE` (falling back to `pm_id`) plus `restart_time` parity, which
keeps workers and overlapping zero-downtime reload generations disjoint without
changing the advertised prefix or total extranonce sizes. The effective value is
`SV2_EXTRANONCE_NAMESPACE_BASE + 2 * worker + (restart_time % 2)` and must be at
most `255` (up to 128 worker lanes at base zero). Startup fails if a PM2 worker
identity is missing or the namespace cannot fit. Independent containers or PM2
worker apps that share mining work must be assigned non-overlapping base ranges;
reserve two namespace values per configured Stratum worker.

### New-block notification path

The master keeps an authoritative Bitcoin Core `getblocktemplate` longpoll open;
hashblock ZMQ remains a watchdog and duplicate results are discarded. Optional
endpoints in `BITCOIN_RPC_AUX_URLS` keep independent longpolls open and race the
primary source, reducing dependence on one node's block-relay peers. An auxiliary
template is only eligible after the primary Core's `getbestblockhash` exactly
matches its previous block hash; a mismatch or unavailable primary fails closed
before any urgent or canonical miner notification. PM2 runs the master through a
minimal, non-HTTP notifier entrypoint so API, Stratum, reporting, and integration
timers cannot delay its Core longpoll callback.

On a new tip, the notifier's first Redis command is a compact SV1 prestage
activation containing only Core-authoritative fixed-width header fields, height,
subsidy, and payout identity. It does not serialize the transaction template or
a second block-template object. Workers consume this on dedicated urgent Redis
publisher/subscriber connections and promote their retained next-height jobs
directly, bypassing the canonical template/RxJS preparation pipeline. It waits
only `SV1_BRIDGE_PUBLISH_BUDGET_MS` for acknowledgement before proceeding. A
timeout immediately retries the activation on the independent normal Redis
command socket. If compact delivery fails or the feature is disabled, the
self-contained subsidy-only bridge remains the fallback.

After canonical publication, the master publishes a durable placeholder-prevhash
empty template for the following height. Stratum workers replay it after restart
and prebuild every connected miner's height- and payout-bound coinbase in batches
of `SV1_PRESTAGE_BATCH_SIZE`, yielding between batches. A newly authorized miner
also stages against the latest template. The next authoritative bridge promotes
the same cached job, patches the authoritative header fields into its already
serialized notify buffer, and writes it without rebuilding the coinbase or JSON.
Canonical full work then follows as a second clean switch. Payout
snapshot creation and Postgres persistence remain outside the urgent path.

SV2 solo channels pre-stage a native subsidy-only future job for the next height.
When the authoritative header arrives, the pool activates that job with only
`SetNewPrevHash`; the same-tip full job follows without a second prevhash switch.
Standard and extended candidates retain exact header/body reconstruction, and
late network-target candidates remain recoverable without crediting stale shares.
Pending SV2 canonical jobs are coalesced per client, while a new-tip activation
is moved ahead of any not-yet-started canonical work for that tip. The finite
defaults are 64 retained jobs per channel, four queued operations, 256 KiB of
outstanding socket writes, and a two-second write-callback deadline. A client is
disconnected if `SV2_MAX_RETAINED_JOBS_PER_CHANNEL`,
`SV2_MAX_QUEUED_JOB_OPERATIONS`, `SV2_MAX_SOCKET_BUFFER_BYTES`, or
`SV2_SOCKET_WRITE_TIMEOUT_MS` is exceeded; `SV2_JOB_RETENTION_MS` controls how
long stale network candidates remain reconstructable.

`SV1_SUBSIDY_BRIDGE_ENABLED=true` enables the solo bridge (the default). PPLNS is
never allowed to fall back to a miner-address coinbase; optional PPLNS bridge
support requires a precomputed subsidy-valued payout snapshot. Retained jobs are
kept for `STRATUM_JOB_RETENTION_MS` so a late network-target candidate can still
be reconstructed and submitted, while ordinary old-tip shares are rejected.
PPLNS seeds use a non-active snapshot status and are skipped if the next
authoritative `nBits` differs from their preparation basis. Before any bridge is
published, the master verifies that Core's `coinbasevalue` equals the locally
calculated consensus subsidy plus every GBT transaction fee. Master startup also
fails if `NETWORK` does not match Core's reported chain.

The Redis protocol remains rolling-deploy compatible: new workers retain the
legacy mining-info reload path, while the master writes the historical latest
key as JSON only after a PPLNS-safe compatibility template is ready. Deploying
workers before the notifier is required for compact activation. During a mixed
deployment, `SV1_COMPACT_ACTIVATION_COMPATIBILITY_BRIDGE=true` publishes the
larger empty bridge immediately after compact activation; disable it after every
worker supports the compact protocol. When any PPLNS
listener is configured and snapshot preparation fails, legacy workers are held
on their prior job instead of being woken with a miner-address fallback job.

Two structured log events expose the end-to-end timing:

- `block_notification_trace` reports Core, bridge, Redis, PPLNS, and persistence stages, separated by payout mode and job type.
- `stratum_job_fanout` reports true source-to-fanout-start time, master publish,
  worker receipt/handling, prestage hits, client count, bytes, backpressure, and
  p50/p95/p99/last enqueue time, correlated by `eventId`.
- `sv1_job_prestage` reports the number of miners prepared for the next height and
  the background preparation duration.
- `sv1_prestage_activation_miss` identifies a worker that could not match an
  authoritative activation to retained prestage state and therefore waits for
  the fallback bridge or canonical full job.

For upstream latency, place the Core nodes in different well-connected networks,
enable normal compact-block relay, and keep Redis and Stratum workers close
together. Auxiliary nodes remain untrusted candidates for tip detection: the
primary Core authorizes their exact tip before publication. Do not point
`BITCOIN_RPC_AUX_URLS` at third-party RPC services.

## Docker

The default compose stack includes Public Pool, TimescaleDB, and Redis. TimescaleDB
stores normal Postgres tables plus immutable accepted-share rows in a hypertable.
Chart and hashrate APIs read from Timescale continuous aggregates plus recent raw
shares for realtime buckets. Redis is used only for process messaging and latest
mining-template replay.

Start the stack:

```bash
$ docker compose up --build -d
```

Use an external TimescaleDB/Postgres server:

```bash
$ DB_HOST=postgres.example.com \
  DB_PORT=5432 \
  DB_USERNAME=public_pool \
  DB_PASSWORD='change-me' \
  DB_DATABASE=public_pool \
  DB_SSL=false \
  docker compose -f docker-compose.external-db.yml up --build -d
```

The external database must be TimescaleDB-compatible and reachable from the
Public Pool container. The startup script waits for the remote `DB_HOST:DB_PORT`,
runs migrations, then starts PM2. Redis still runs locally in this compose file
unless `REDIS_URL` is pointed at an external Redis instance.

Set `DB_SSL=true` if the external database requires TLS. For private CA or
self-signed test deployments, `DB_SSL_REJECT_UNAUTHORIZED=false` disables
certificate verification; do not use that setting for normal internet-facing
production databases.

For a fresh external database, create the role/database first:

```sql
CREATE USER public_pool WITH PASSWORD 'change-me';
CREATE DATABASE public_pool OWNER public_pool;
\c public_pool
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
```

If TimescaleDB is managed by another operator, make sure the `public_pool` role
can create tables, indexes, continuous aggregates, and Timescale policies in the
target database.

Run only the database migrations:

```bash
$ docker compose run --rm public-pool npm run migration:run:prod
```

Watch logs:

```bash
$ docker compose logs --tail 100 -f public-pool
```

Back up TimescaleDB:

```bash
$ docker compose exec timescaledb pg_dump -U public_pool public_pool > public-pool.sql
```

Redis does not hold durable accounting data. Losing Redis requires workers to
replay the latest template from Redis after reconnect or fall back to the saved
RPC block template table.

**note**: To successfully connect to the bitcoin RPC you will need to add

```
rpcallowip=172.16.0.0/12
zmqpubhashblock=tcp://0.0.0.0:3000
```

to your bitcoin.conf.

## Testing

Baseline unit regression capture:

```bash
$ npm run test:baseline
```

Unit tests:

```bash
$ npm test
```

Integration tests against real TimescaleDB and Redis:

```bash
$ docker compose -f docker-compose.test.yml up --build --abort-on-container-exit
```

With the full-setup regtest Bitcoin Core running, validate reconstructed empty
and full blocks through BIP23 proposal mode:

```bash
$ RUN_BITCOIN_REGTEST_INTEGRATION=true \
  npm run test:integration -- bitcoin-regtest-proposal
```
