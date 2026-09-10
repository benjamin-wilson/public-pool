# Contributing to Public Pool

Thanks for taking the time to contribute. Bug reports, fixes and features are all welcome.

## Prerequisites

- **Node.js `22.12.0` or newer** — enforced by the `engines` field in `package.json`
- **A Bitcoin Core node** with RPC enabled and reachable from the pool

If you do not run a node already, [`full-setup/`](full-setup/) contains Docker Compose stacks that start Bitcoin Core and Public Pool together for mainnet, testnet or regtest.

## Getting set up

```bash
# fork the repository, then
$ git clone https://github.com/<your-username>/public-pool.git
$ cd public-pool
$ npm install
$ cp .env.example .env
```

Edit `.env` and point `BITCOIN_RPC_URL`, `BITCOIN_RPC_USER` and `BITCOIN_RPC_PASSWORD` at your node. See the Configuration section of the [README](README.md) for every available option.

Then run the server in watch mode:

```bash
$ npm run start:dev
```

### Developing without mainnet

Set `NETWORK=regtest` in `.env` and use the regtest stack in [`full-setup/`](full-setup/README.md). It lets you generate blocks on demand, so you can exercise the full submit-and-find path without waiting on real network difficulty.

## Before opening a pull request

```bash
$ npm run lint     # eslint, applies --fix
$ npm run format   # prettier
$ npm run test     # jest
```

Please make sure the test suite passes. If you are changing Stratum message handling, mining job construction or difficulty calculation, add or update the matching `*.spec.ts` file — those areas already have unit tests and are the easiest places to introduce subtle breakage.

## Code style

Style is enforced by ESLint and Prettier, configured in [`.eslintrc.js`](.eslintrc.js) and [`.prettierrc`](.prettierrc):

- Single quotes
- Trailing commas everywhere
- `@typescript-eslint/recommended`

Run `npm run format` rather than adjusting formatting by hand.

## Project layout

```
src/
  app.controller.ts      Pool, network and info endpoints
  controllers/           Client and external-share endpoints
  models/                Stratum messages, mining jobs, client state
  models/stratum-messages/  One class per Stratum V1 method
  services/              Bitcoin RPC, Stratum server, notifications
  ORM/                   TypeORM entities and services (SQLite)
  utils/                 Difficulty helpers
full-setup/              Bitcoin Core + Public Pool compose stacks
```

Unit tests live next to the code they cover as `*.spec.ts`.

## Pull requests

- Branch from `master` and open your pull request against `master`.
- Keep changes focused. A small, single-purpose pull request is much easier to review than a broad one.
- Describe what the change does and why. If it fixes an issue, reference it.
- Note in the description if you have tested against mainnet, testnet or regtest.

## Reporting bugs

Open an [issue](https://github.com/benjamin-wilson/public-pool/issues) and include:

- What you expected to happen, and what happened instead
- Your `NETWORK` setting and Node.js version
- The miner hardware and firmware you are connecting with, if relevant
- Relevant log output, with RPC credentials and addresses redacted

For security vulnerabilities, please do **not** open a public issue — see [SECURITY.md](SECURITY.md).
