#!/bin/bash

test -z "${2}" && echo "USAGE: ${0} <network_id> <file://build.yml> [data dir]" && exit 1

network_id=${1}
network_build=${2}
dir=${3:-/tmp}
socket=${dir}/appchain.sock

cat <<EOF
Initialize Network:
  data directory: '${dir}'
  network id: '${network_id}'
  network build file: '${network_build}'
EOF

mkdir -p "${dir}"

node \
  --experimental-specifier-resolution=node \
  --experimental-vm-modules \
  --experimental-wasm-modules \
  --experimental-wasm-threads \
  --no-warnings \
  dist/index.js \
  --admin \
  --debug \
  --ipfs \
  --ipfs-data ${dir}/ipfs \
  --key ${dir}/admin.key \
  --listen \
  --nonce \
  --socket ${socket} \
  --tx-status-retries 0 \
  &
PID=$!

# Wait for the socket to exist
while [ ! -S ${socket} ]; do sleep 1; done

appchain () {
  echo "$@" | tee >(cat >&2) | nc -U -q 0 ${socket}
  sleep 1s
}

appchain admin setAdmin
appchain nodes setRegistrationStake 0
appchain nodes openRegistration
appchain networks register ${network_id} ${network_build}
appchain networks setActive ${network_id}

kill ${PID}

rm -f ${socket}
