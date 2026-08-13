#!/bin/sh
# 200 lines of 100 chars — enough to overflow a small maxBuffer quickly.
i=0
while [ "$i" -lt 200 ]; do
  printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n'
  i=$((i + 1))
done
