#!/bin/sh
# A well-behaved service: reports on both streams, then idles until signalled.
# Extra arguments are ignored, so the same script can stand in for a "changed"
# start script in staleness tests.
printf 'ready\n'
printf 'warming up\n' >&2
while true; do
  sleep 0.05
done
