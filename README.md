## Description

A Nestjs and Typescript Bitcoin stratum mining server.

## Installation

```bash
$ npm install
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
Install pm2 (https://pm2.keymetrics.io/)

```bash
$ pm2 start dist/main.js
```

