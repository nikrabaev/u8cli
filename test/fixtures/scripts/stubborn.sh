#!/bin/sh
# Ignores SIGTERM (children inherit the ignore), so only SIGKILL ends it.
trap '' TERM
printf 'stubborn\n'
while true; do
  sleep 0.1
done
