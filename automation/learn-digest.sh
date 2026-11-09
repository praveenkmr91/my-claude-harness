#!/usr/bin/env bash
# Usage: learn-digest.sh <projects-root> <cursor> <out-dir>
# One digest per kept session under <out-dir>; sessions past the set cap are listed in <out-dir>/skipped.txt.
set -u -o pipefail
export PATH="/opt/homebrew/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:/usr/bin:/bin"

if [ $# -ne 3 ] || [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
  echo "usage: learn-digest.sh <projects-root> <cursor> <out-dir>" >&2
  exit 2
fi
cursor=$2
out=$3
file_cap=${LEARN_DIGEST_FILE_CAP:-40960}
set_cap=${LEARN_DIGEST_SET_CAP:-409600}
case "$file_cap$set_cap" in *[!0-9]* | "") echo "learn-digest: caps must be whole numbers of bytes" >&2; exit 2 ;; esac

root=$(cd -- "$1" 2>/dev/null && pwd) || { echo "learn-digest: projects root not found: $1" >&2; exit 1; }
mkdir -p -- "$out" && find "$out" -mindepth 1 -delete || { echo "learn-digest: cannot empty $out" >&2; exit 1; }

LIB="$HOME/.claude/hooks/lib"

read -r -d '' WRITE_DIGEST <<'PY'
import json, re, sys

header, cap, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sys.stdin.reconfigure(encoding="utf-8")
limits = {"user": 500, "assistant": 400}

lines = []
for raw in sys.stdin:
    rec = json.loads(raw)
    text = re.sub(r'<private>.*?</private>', '', rec["t"], flags=re.S)
    text = re.sub(r'\s+', ' ', text).strip()
    if text:
        lines.append(rec["k"] + ": " + text[:limits[rec["k"]]])

def size(line):
    return len(line.encode("utf-8")) + 1

def note(cut):
    return "[head cut: first %d of %d records dropped to fit the %d-byte file cap]" % (cut, len(lines), cap)

sizes = [size(line) for line in lines]
tail = sum(sizes)
cut = 0
if len(lines) > 1 and size(header) + tail > cap:
    cut = 1
    tail -= sizes[0]
    while cut < len(lines) - 1 and size(header) + size(note(cut)) + tail > cap:
        tail -= sizes[cut]
        cut += 1

with open(out, "w", encoding="utf-8", errors="replace") as f:
    f.write(header + "\n")
    if cut:
        f.write(note(cut) + "\n")
    for line in lines[cut:]:
        f.write(line + "\n")
PY

if [ -e "$cursor" ]; then recent=(-newer "$cursor"); else recent=(-mtime -7); fi
files=$(find "$root" -mindepth 2 -maxdepth 2 -type f -name '*.jsonl' "${recent[@]}" -exec stat -f '%m %N' -- {} + | sort -rn | cut -d' ' -f2-)

total=0
failed=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  # The marker is read from raw string content only: a tool result is an array and may quote it.
  summary=$(jq -R -n -r -L "$LIB" 'include "turns";
    [inputs | fromjson? | select(type == "object")] as $r
    | [([$r[] | select(.type? == "assistant") | .message.content[]?
          | select(type == "object" and .type == "tool_use" and (.input | type) == "object" and .input.skill == "learn")] | length > 0)
        or ([$r[] | select(.type? == "user" and (.message.content? | type) == "string"
          and (.message.content | contains("<command-name>/learn</command-name>")))] | length > 0),
       ([$r[] | typed_text] | length),
       (first($r[] | .cwd? // empty) // "")]
    | @tsv' -- "$file") || { echo "learn-digest: cannot read $file" >&2; failed=1; continue; }
  IFS=$'\t' read -r ran_learn typed cwd <<<"$summary"
  [ "$ran_learn" = false ] && [ "$typed" -ge 3 ] || continue

  if [ "$total" -ge "$set_cap" ]; then
    printf '%s\n' "$file" >> "$out/skipped.txt" || { echo "learn-digest: cannot write $out/skipped.txt" >&2; exit 1; }
    continue
  fi

  digest="$out/$(basename "$file" .jsonl).md"
  if jq -R -c -L "$LIB" 'include "turns";
       fromjson? | select(type == "object")
       | (typed_text | {k: "user", t: .}), (assistant_text | {k: "assistant", t: .})' -- "$file" \
     | python3 -c "$WRITE_DIGEST" "# $file · repo $cwd" "$file_cap" "$digest"; then
    total=$((total + $(stat -f %z -- "$digest")))
  else
    echo "learn-digest: cannot digest $file" >&2
    failed=1
  fi
done <<<"$files"

[ "$failed" -eq 0 ]
