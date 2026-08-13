#!/bin/sh
# A well-behaved service: announces itself, then idles until signalled.
printf 'ready\n'
while true; do
  sleep 0.1
done
