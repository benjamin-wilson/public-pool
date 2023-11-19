#!/bin/bash

mkdir -p data/{mainnet,testnet}/bitcoin
mkdir -p data/{mainnet,testnet}/public-pool

chown 65532:65532 data/{mainnet,testnet}/bitcoin -R