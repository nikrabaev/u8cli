#!/bin/sh
# Backgrounds a long sleep, records its pid in $1, then blocks.
# Used to prove that killing the process group reaps grandchildren too.
sleep 30 &
echo "$!" > "$1"
sleep 30
