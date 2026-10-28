#!/bin/sh
set -eu
kitty-page quit

# Boat's snapshot scanner cannot traverse a user's private GVFS FUSE mount.
gvfs_dir="$HOME/.gvfs"
gvfs_mount() {
    mounts=$(findmnt --kernel --raw --noheadings --nocanonicalize --output TARGET,FSTYPE,FS-OPTIONS) || return
    printf '%s\n' "$mounts" | awk -v target="$gvfs_dir" '$1 == target { print $2, $3 }'
}
mounted=$(gvfs_mount)
if [ -n "$mounted" ]; then
    type=${mounted%% *}
    options=${mounted#* }
    if [ "$type" != fuse.gvfsd-fuse ]; then
        echo "Cannot checkpoint: an unexpected filesystem is mounted at $gvfs_dir" >&2
        exit 1
    fi
    case ",$options," in
        *",user_id=$(id -u),"*) ;;
        *) echo "Cannot checkpoint: the GVFS mount belongs to another user" >&2; exit 1 ;;
    esac
    if command -v fusermount3 >/dev/null 2>&1; then
        fusermount3 -u "$gvfs_dir"
    else
        fusermount -u "$gvfs_dir"
    fi
    remaining=$(gvfs_mount)
    if [ -n "$remaining" ]; then
        echo "Cannot checkpoint: the GVFS mount is still active" >&2
        exit 1
    fi
fi
sync
