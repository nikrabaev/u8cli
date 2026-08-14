#!/bin/sh
# A stop script that lies: records that it ran in $1 and exits 0 without
# stopping anything. The supervisor must still reap the process group.
printf 'stop script ran\n' > "$1"
exit 0
