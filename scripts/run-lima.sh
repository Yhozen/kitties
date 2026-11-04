#!/bin/sh
set -eu
task_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$task_root"
for tool in go npm limactl; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "Missing $tool. Install Go, Node.js/npm and Lima 2 or later first." >&2
        exit 1
    }
done
make build
case "${1:-}" in
    --demo)
        exec ./dist/kitties -vm-demo gateway
        ;;
    "")
        export KITTIES_DATA_DIR="${KITTIES_DATA_DIR:-$HOME/.kitties-lima}"
        exec ./dist/kitties -config configs/lima.yaml gateway
        ;;
    *)
        echo "Usage: scripts/run-lima.sh [--demo]" >&2
        exit 2
        ;;
esac
