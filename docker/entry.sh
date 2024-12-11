#!/bin/sh

# map env var name to the one used internally
test ! -z "${URL_APPCHAIN_SEQUENCER}" \
  && echo "URL_APPCHAIN_SEQUENCER=${URL_APPCHAIN_SEQUENCER}" \
  && export NEXT_PUBLIC_PROTOKIT_GRAPHQL_URL="${URL_APPCHAIN_SEQUENCER}"

exec "$@"
