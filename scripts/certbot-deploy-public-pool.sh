#!/bin/sh

set -eu

lineage=${RENEWED_LINEAGE:-/etc/letsencrypt/live/public-pool.io}
secrets_dir=${PUBLIC_POOL_SECRETS_DIR:-/home/ben/public-pool-timescaledb-test/secrets}
container=${PUBLIC_POOL_CONTAINER:-public-pool}
owner=${PUBLIC_POOL_CERT_OWNER:-ben}
group=${PUBLIC_POOL_CERT_GROUP:-ben}

cert_source="$lineage/fullchain.pem"
key_source="$lineage/privkey.pem"

test -r "$cert_source"
test -r "$key_source"
openssl x509 -in "$cert_source" -noout >/dev/null
openssl pkey -in "$key_source" -noout >/dev/null

cert_temp=$(mktemp "$secrets_dir/.cert.pem.XXXXXX")
key_temp=$(mktemp "$secrets_dir/.key.pem.XXXXXX")
trap 'rm -f "$cert_temp" "$key_temp"' EXIT HUP INT TERM

cat "$cert_source" > "$cert_temp"
cat "$key_source" > "$key_temp"
chown "$owner:$group" "$cert_temp" "$key_temp"
chmod 0644 "$cert_temp"
chmod 0600 "$key_temp"
mv -f "$cert_temp" "$secrets_dir/cert.pem"
mv -f "$key_temp" "$secrets_dir/key.pem"

# HTTPS can reload its secure context, but the Stratum TLS listeners currently
# read their certificate only when they start.
docker restart --time 30 "$container" >/dev/null
