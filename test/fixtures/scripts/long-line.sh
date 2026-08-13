#!/bin/sh
# One 300-char line, to exercise the max-line-length splitter.
i=0
while [ "$i" -lt 30 ]; do
  printf 'aaaaaaaaaa'
  i=$((i + 1))
done
printf '\n'
printf 'after\n'
