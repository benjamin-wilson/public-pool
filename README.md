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

Install pm2 (https://pm2.keymetrics.io/)

```bash
$ pm2 start dist/main.js
```

## Docker

Build container:

```bash
$ docker build -t public-pool .
```

Run container (with default configuration):

```bash
$ docker container run --name public-pool --rm -p 3333:3333 -p 3334:3334 -p 8332:8332 public-pool
```

Run container (with custom configuration):

```bash
$ docker container run --name public-pool --rm -p 3333:3333 -p 3334:3334 -p 8332:8332 -v .env:.env public-pool
```
