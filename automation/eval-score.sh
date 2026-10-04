#!/usr/bin/env bash
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
. "$(dirname "$0")/eval-lib.sh"

JUDGE_HEAD='You match review findings against a fixed list of known flaws. A finding is a hit for flaw X when it names the same defect at the same file or plan step as X; the right place with a different defect is not a hit. A finding that matches no flaw is a false positive; copy its text exactly. Reply with only JSON: {"hits":[flaw ids],"misses":[flaw ids],"false_positives":[finding text]}. Every flaw id appears in exactly one of hits or misses.'

# Judge replies may wrap the JSON in prose or fences, and findings text can itself contain braces.
extract_json() {
  local rest candidate
  [[ $1 == *\{* ]] || return 1
  rest="{${1#*\{}"
  while [[ $rest == *\}* ]]; do
    candidate="${rest%\}*}}"
    if jq -e 'type == "object"' <<<"$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
    rest=${rest%\}*}
  done
  return 1
}

score_case() {
  local case=$1 dir="$EVAL_ROOT/cases/$1" run findings prompt raw reply verdict judge_cwd
  [ -f "$dir/flaws.json" ] || { echo "ERROR no flaws.json for case $case" >&2; exit 1; }
  # Outside $HOME so no project CLAUDE.md reaches the judge.
  judge_cwd=$(mktemp -d) || exit 1
  for run in $(ok_runs "$case"); do
    findings=$(jq -r 'select(.type=="result") | .result' "$run")
    prompt=$(printf '%s\n\nKNOWN FLAWS:\n%s\n\nFINDINGS:\n%s' "$JUDGE_HEAD" "$(cat "$dir/flaws.json")" "$findings")
    raw=$(cd "$judge_cwd" && "$CLAUDE_BIN" -p "$prompt" --model opus --effort high --no-session-persistence \
      --output-format json --tools "" --setting-sources project,local </dev/null) \
      || { rm -rf "$judge_cwd"; echo "ERROR judge call failed: $run" >&2; exit 1; }
    reply=$(jq -r '.result' <<<"$raw") \
      || { rm -rf "$judge_cwd"; echo "ERROR judge output is not JSON: $run" >&2; exit 1; }
    verdict=$(extract_json "$reply") \
      || { rm -rf "$judge_cwd"; echo "ERROR no JSON object in judge reply: $run" >&2; exit 1; }
    if ! jq -e --slurpfile f "$dir/flaws.json" '
          ($f[0] | map(.id | tostring) | sort) as $ids
          | ((.hits + .misses) | map(tostring) | sort) == $ids
            and ($ids | length) == ($ids | unique | length)
            and (.false_positives | type == "array")' <<<"$verdict" >/dev/null 2>&1; then
      rm -rf "$judge_cwd"
      echo "ERROR judge verdict does not cover each flaw id exactly once: $run" >&2
      exit 1
    fi
    printf '%s\n' "$verdict" >"${run%.jsonl}.score.json"
  done
  rm -rf "$judge_cwd"
}

aggregate() {
  local dir case run records=""
  for dir in "$EVAL_ROOT"/cases/*/; do
    [ -f "$dir/kind" ] || continue
    case=$(basename "$dir")
    for run in $(ok_runs "$case"); do
      records="$records$(score_record "$case" "$run")"$'\n'
    done
  done
  printf '%s' "$records" | jq -rs --arg now "$(date '+%F %T')" '
    def f1: (. * 10 | round) as $t | "\($t / 10 | floor).\($t % 10)";
    def mean: add / length;
    def table($kind; $title):
      map(select(.kind == $kind)) as $recs
      | "## \($title) cases (\($recs | map(.case) | unique | length))\n\n"
        + if ($recs | length) == 0 then "_No scored runs._"
          else
            "| config | runs | original recall | pooled recall | spread | mean false positives |\n|---|---|---|---|---|---|\n"
            + ($recs | group_by(.config) | map(
                . as $cfg
                | ($cfg | group_by(.case) | map(sort_by(.n))) as $cases
                | ($cases | map(length) | min) as $k
                | "| \($cfg[0].config) | \($cases | map(length) | if min == max then "\(min)" else "\(min)-\(max)" end) | "
                  + "\(100 * ($cases | map(map(.orig_hits) | mean) | add) / ($cases | map(.[0].orig_total) | add) | f1)% | "
                  + "\(100 * ($cases | map(map(.pool_hits) | mean) | add) / ($cases | map(.[0].pool_total) | add) | f1)% | "
                  + "\([range(0; $k) as $i | 100 * ($cases | map(.[$i].pool_hits) | add) / ($cases | map(.[0].pool_total) | add)] | max - min | f1) pts | "
                  + "\($cfg | map(.fps) | mean | f1) |"
              ) | join("\n"))
          end;
    "# Tier eval results\n\n_Generated \($now)_\n\n"
    + "Recall per run = sum of hits / sum of flaws across the kind'"'"'s cases, per run index. "
    + "Recall = mean over a config'"'"'s runs (cases with uneven run counts are averaged per case first). "
    + "Original = flaws without `pooled: true`; pooled = all flaws. "
    + "Spread = max - min pooled recall across the run indexes every case has. Mean false positives = per run file.\n\n"
    + table("plan"; "Plan") + "\n\n" + table("code"; "Code") + "\n"
  ' >"$EVAL_ROOT/results.md.tmp" && mv "$EVAL_ROOT/results.md.tmp" "$EVAL_ROOT/results.md"
}

case ${1:-} in
  "") echo "usage: eval-score.sh <case-id> | --aggregate" >&2; exit 1 ;;
  --aggregate) aggregate ;;
  *) score_case "$1" && aggregate ;;
esac
