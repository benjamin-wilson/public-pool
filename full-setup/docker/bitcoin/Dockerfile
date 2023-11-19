# Use an official Ubuntu as a parent image
FROM ubuntu:22.04 AS build

ARG BITCOIN_CORE_VER=25.1

# Install Bitcoin Core
RUN apt-get update && \
    apt-get install -y curl wget tar

WORKDIR /app

# download and extract bitcoin core
RUN wget https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_CORE_VER}/bitcoin-${BITCOIN_CORE_VER}-x86_64-linux-gnu.tar.gz -O - | tar xzv --strip-components=1

RUN pwd
RUN find -ls

# use nonroot container
FROM gcr.io/distroless/cc-debian11:nonroot

# Copy the app dir into distroless image
COPY --chown=nonroot:nonroot --from=build /app /app


# Expose port 8332 for RPC and 8333 for peer connections
EXPOSE 8332 8333
EXPOSE 18332 18333

# Run bitcoind by default when the container starts.
ENTRYPOINT ["/app/bin/bitcoind"]

# Additional arguments can be passed to bitcoind via CMD
# For example, to run in testnet mode, use docker run with the argument `-testnet`
CMD ["-printtoconsole", "-datadir=/app/data"]

