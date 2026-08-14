#!/bin/sh
# $1 = counter file, $2 = number of runs that must fail before this one stays up.
# Lets a test drive "crash, crash, then healthy" without any sleeping.
count=$(( $(cat "$1" 2>/dev/null || echo 0) + 1 ))
printf '%s\n' "$count" > "$1"
printf 'attempt %s\n' "$count"
if [ "$count" -le "$2" ]; then
  exit 1
fi
while true; do
  sleep 0.05
done
