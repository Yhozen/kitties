#!/bin/sh
# Puts back what kitty-backup took, from a tar.gz on the standard input. A file that is already
# there stays: a workspace that kept its browser profile is newer than any backup of it.
#   kitty-restore < backup.tar.gz
set -eu
tar -xzf - -C /home/kitty --skip-old-files
chmod 700 /home/kitty/.ssh 2>/dev/null || true
echo restored
