#!/bin/sh
# LF line, CRLF line, a stderr line, then a final line with NO trailing newline.
printf 'alpha\n'
printf 'beta\r\n'
printf 'boom\n' >&2
printf 'trailing-partial'
