#!/bin/sh
# Writes to both streams and exits with the code given as $1 (default 0).
printf 'out-one\n'
printf 'err-one\n' >&2
printf 'out-two\n'
exit "${1:-0}"
