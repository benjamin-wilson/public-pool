# Security Policy

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Public Pool constructs coinbase transactions, handles Bitcoin RPC credentials and accepts untrusted input from mining hardware over the network. A publicly disclosed flaw could be exploited against live pools before operators have a chance to update.

Instead, report privately:

- Use **GitHub private vulnerability reporting** — go to the [Security tab](https://github.com/benjamin-wilson/public-pool/security) and choose *Report a vulnerability*.
- If that is unavailable, contact the maintainer directly rather than filing a public issue.

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce, or a proof of concept
- The affected version or commit
- The network you observed it on (mainnet, testnet or regtest)

## Scope

Issues that are especially relevant to this project:

- Coinbase or merkle construction flaws that could misdirect a block reward
- Stratum message parsing that can crash, hang or be used to exhaust server resources
- Share validation bypasses, including submitting work that credits another address
- Exposure of Bitcoin RPC credentials, cookie file contents, or the TLS key in `secrets/`
- Authorization flaws allowing one address to read or affect another's workers

The following are generally **not** vulnerabilities in this project:

- Misconfiguration of your own Bitcoin node, such as an over-permissive `rpcallowip`
- Exposing the Stratum or API port to the public internet without a firewall
- Denial of service that requires privileged network position or physical access

## Supported versions

This project does not currently publish tagged releases. Security fixes are applied to the `master` branch, and operators are encouraged to track it.

## Disclosure

Please give a reasonable window to investigate and ship a fix before disclosing publicly. Reports will be acknowledged, and credit given if you would like it.

## Hardening reminders for operators

- **Replace the bundled TLS certificate before enabling `API_SECURE`.** `secrets/cert.pem` and `secrets/key.pem` are committed to this repository as a convenience default. It is a self-signed certificate for `127.0.0.1`, and **its private key is public**. Serving the API over HTTPS with it provides no confidentiality, because anyone can obtain the key and decrypt or impersonate the connection. Generate your own key pair for any deployment that is not purely local.
- Keep the API port (`API_PORT`, default `3334`) bound to localhost or behind a reverse proxy unless you intend it to be public. The bundled `docker-compose.yml` binds to `127.0.0.1` by default.
- Prefer `BITCOIN_RPC_COOKIEFILE` over storing an RPC password in `.env`.
- Do not commit your `.env`. It is already covered by `.gitignore`.
- Scope `rpcallowip` in `bitcoin.conf` as narrowly as your deployment allows.
