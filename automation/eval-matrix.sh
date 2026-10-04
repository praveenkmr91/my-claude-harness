#!/usr/bin/env bash
set -u
export PATH="/opt/homebrew/bin:/usr/bin:/bin"
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/eval-lib.sh"

PLAN_CONFIGS=("opus medium" "opus high" "claude-fable-5-1 medium")
CODE_CONFIGS=("sonnet high" "opus medium" "opus high")

preflight() {
  local failed=0 dir case sb count i id cmd expect out
  for dir in "$EVAL_ROOT"/cases/*/; do
    dir=${dir%/}
    [ "$(<"$dir/kind")" = plan ] || continue
    case=$(basename "$dir")
    sb=$(mktemp -d) || exit 1
    if build_sandbox "$dir" "$sb"; then
      count=$(jq length "$dir/flaws.json")
      for ((i = 0; i < count; i++)); do
        id=$(jq -r ".[$i].id" "$dir/flaws.json")
        cmd=$(jq -r ".[$i].evidence.cmd // empty" "$dir/flaws.json")
        expect=$(jq -r ".[$i].evidence.expect // empty" "$dir/flaws.json")
        if [ -z "$cmd" ] || [ -z "$expect" ]; then
          echo "PREFLIGHT $case/$id: evidence has no cmd or expect"
          failed=1
          continue
        fi
        out=$(cd "$sb" && bash -c "$cmd" 2>&1 </dev/null)
        if [[ $out != *"$expect"* ]]; then
          echo "PREFLIGHT $case/$id: output lacks expected text '$expect'"
          failed=1
        fi
      done
    else
      failed=1
    fi
    rm -rf "$sb"
  done
  [ "$failed" -eq 0 ] || exit 1
}

# Fable cells last so a usage limit leaves the cheaper cells complete.
list_cells() {
  local fable dir kind cfg model effort configs
  for fable in 0 1; do
    for dir in "$EVAL_ROOT"/cases/*/; do
      dir=${dir%/}
      [ -f "$dir/kind" ] || continue
      kind=$(<"$dir/kind")
      case $kind in
        plan) configs=("${PLAN_CONFIGS[@]}") ;;
        code) configs=("${CODE_CONFIGS[@]}") ;;
        *) echo "ERROR unknown kind '$kind' in $dir" >&2; exit 1 ;;
      esac
      for cfg in "${configs[@]}"; do
        read -r model effort <<<"$cfg"
        case $model in *fable*) [ "$fable" -eq 1 ] || continue ;; *) [ "$fable" -eq 0 ] || continue ;; esac
        echo "$(basename "$dir") $model $effort"
      done
    done
  done
}

run_count() {
  ok_runs "$1" "$2-$3-[0-9]" | wc -l | tr -d ' '
}

ensure_runs() {
  local have
  have=$(run_count "$1" "$2" "$3")
  while [ "$have" -lt "$4" ]; do
    echo "run $1 $2 $3 ($((have + 1))/$4)"
    bash "$HERE/eval-run.sh" "$1" "$2" "$3" >/dev/null \
      || { echo "ERROR run failed: $1 $2 $3; rerun eval-matrix.sh to resume" >&2; exit 1; }
    have=$((have + 1))
  done
}

spread_over_20() {
  local run records=""
  for run in $(ok_runs "$1" "$2-$3-[0-9]"); do
    records="$records$(score_record "$1" "$run")"$'\n'
  done
  printf '%s' "$records" | jq -es 'length >= 2 and ((map(100 * .pool_hits / .pool_total) | max - min) > 20)' >/dev/null
}

preflight

cells=()
while IFS= read -r cell; do
  cells+=("$cell")
done < <(list_cells)
[ ${#cells[@]} -gt 0 ] || { echo "ERROR no cases under $EVAL_ROOT/cases" >&2; exit 1; }

for cell in "${cells[@]}"; do
  read -r case model effort <<<"$cell"
  ensure_runs "$case" "$model" "$effort" 2
done

for dir in "$EVAL_ROOT"/cases/*/; do
  [ -f "$dir/kind" ] || continue
  echo "score $(basename "$dir")"
  bash "$HERE/eval-score.sh" "$(basename "$dir")" || exit 1
done

rescore=()
for cell in "${cells[@]}"; do
  read -r case model effort <<<"$cell"
  if [ "$(run_count "$case" "$model" "$effort")" -lt 3 ] && spread_over_20 "$case" "$model" "$effort"; then
    ensure_runs "$case" "$model" "$effort" 3
    rescore+=("$case")
  fi
done

if [ ${#rescore[@]} -gt 0 ]; then
  for case in $(printf '%s\n' "${rescore[@]}" | sort -u); do
    echo "rescore $case"
    bash "$HERE/eval-score.sh" "$case" || exit 1
  done
fi

bash "$HERE/eval-score.sh" --aggregate
echo "results: $EVAL_ROOT/results.md"
