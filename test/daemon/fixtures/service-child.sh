#!/bin/sh
# Backgrounds a long sleep and records its pid in $1, then idles.
# Proves the supervisor sweeps the whole process group, not just the leader.
sleep 30 &
echo "$!" > "$1"
printf 'ready\n'
while true; do
  sleep 0.05
done
