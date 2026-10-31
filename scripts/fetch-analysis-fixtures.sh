#!/bin/sh
# Downloads the JamendoLyrics evaluation songs (CC licenses, some NC/ND: never commit them) with word-level
# lyric timings, pinned to a dataset revision and verified against scripts/analysis-fixtures.sha256.
# Output: tests/fixtures/.cache/jamendolyrics/{mp3,words}/. Optional arguments limit languages: en de fr es.
# Source and per-song licenses: https://huggingface.co/datasets/jamendolyrics/jamendolyrics
set -e
root="$(cd "$(dirname "$0")/.." && pwd)"
manifest="$root/scripts/analysis-fixtures.sha256"
out="$root/tests/fixtures/.cache/jamendolyrics"
rev=de188c963fd4539bc769b3feb83582e5a9595e36
base="https://huggingface.co/datasets/jamendolyrics/jamendolyrics/resolve/$rev"
langs="${*:-en de fr es}"
mkdir -p "$out/mp3" "$out/words"
curl -sfL -o "$out/JamendoLyrics.csv" "$base/JamendoLyrics.csv"

songs="$(mktemp)"
trap 'rm -f "$songs"' EXIT
for l in $langs; do grep -F "  subsets/$l/mp3/" "$manifest" | sed 's|.*/||; s|\.mp3$||' >> "$songs"; done

failed=0
while read -r sum path; do
  name="$(basename "$path")"
  case "$path" in
    subsets/*) dest="$out/mp3/$name" ;;
    annotations/words/*) dest="$out/words/$name" ;;
    *) continue ;;
  esac
  grep -qxF "${name%.*}" "$songs" || continue
  if [ -s "$dest" ] && echo "$sum  $dest" | sha256sum -c --status; then continue; fi
  url="$base/$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$path")"
  if ! curl -sfL -o "$dest" "$url"; then
    echo "download failed: $path" >&2
    failed=1
  elif ! echo "$sum  $dest" | sha256sum -c --status; then
    echo "checksum mismatch: $path" >&2
    rm -f "$dest"
    failed=1
  fi
done < "$manifest"
echo "$(ls "$out/mp3" | wc -l) songs, $(ls "$out/words" | wc -l) word timings in $out"
exit $failed
