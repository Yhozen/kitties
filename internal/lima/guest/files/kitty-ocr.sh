#!/bin/sh
# Prints the text on the display as a line per piece of text: "x,y<TAB>text", where x,y is the
# centre of the text on the display (what a click there needs). Cheaper for a model than a
# picture when all it needs is to read the screen or find a word to click.
#   kitty-ocr [languages, as tesseract names them: eng, spa, eng+spa…]
set -eu
: "${DISPLAY:=:99}"
lang="${1:-${KITTY_OCR_LANG:-eng+spa}}"
dir="$(mktemp -d /tmp/ocr-XXXXXX)"
trap 'rm -rf "$dir"' EXIT
scrot -o "$dir/screen.png" >/dev/null 2>&1
# Sparse text (11) finds the scattered labels of a window; a word whose confidence is low is
# noise. Words of one line are joined, and the line's box gives its centre.
tesseract "$dir/screen.png" stdout -l "$lang" --psm 11 tsv 2>/dev/null | awk -F'\t' '
    NR > 1 && $1 == 5 && $11 >= 40 && $12 !~ /^[ \t]*$/ {
        key = $3 "." $4 "." $5
        if (!(key in text)) {
            order[++n] = key
            left[key] = $7; top[key] = $8; right[key] = $7 + $9; bottom[key] = $8 + $10
            text[key] = $12
            next
        }
        text[key] = text[key] " " $12
        if ($7 < left[key]) left[key] = $7
        if ($8 < top[key]) top[key] = $8
        if ($7 + $9 > right[key]) right[key] = $7 + $9
        if ($8 + $10 > bottom[key]) bottom[key] = $8 + $10
    }
    END {
        for (i = 1; i <= n; i++) {
            k = order[i]
            printf "%d,%d\t%s\n", (left[k] + right[k]) / 2, (top[k] + bottom[k]) / 2, text[k]
        }
    }'
