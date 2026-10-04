#!/usr/bin/env bash
EVAL_ROOT=${EVAL_ROOT:-$HOME/.claude/evals}
EVAL_STATE=${EVAL_STATE:-$HOME/.claude/state/evals}
CLAUDE_BIN=${CLAUDE_BIN:-claude}

build_sandbox() {
  local dir=$1 sb=$2 kind repo ref status src dest
  kind=$(<"$dir/kind")
  repo=$(<"$dir/repo")
  ref=$(<"$dir/ref")
  git -C "$repo" archive "$ref" | tar -x -C "$sb"
  status=("${PIPESTATUS[@]}")
  if [ "${status[0]}" -ne 0 ] || [ "${status[1]}" -ne 0 ]; then
    echo "ERROR cannot archive $ref from $repo" >&2
    return 1
  fi
  case $kind in
    plan)
      if [ -f "$dir/extras" ]; then
        while read -r src dest; do
          [ -n "$src" ] || continue
          case $src in /*) ;; *) src=$dir/$src ;; esac
          if [ -d "$src" ]; then
            mkdir -p "$sb/$dest" && cp -R "$src/." "$sb/$dest/" || return 1
          elif [ -f "$src" ]; then
            mkdir -p "$(dirname "$sb/$dest")" && cp "$src" "$sb/$dest" || return 1
          else
            echo "ERROR extras source missing: $src" >&2
            return 1
          fi
        done <"$dir/extras"
      fi
      sed -e "s|~/\.claude/|$sb/|g" -e "s|$HOME/\.claude/|$sb/|g" "$dir/input.md" >"$sb/REVIEW_INPUT.md" || return 1
      ;;
    code) cp "$dir/input.diff" "$sb/input.diff" || return 1 ;;
    *)
      echo "ERROR unknown kind '$kind' in $dir" >&2
      return 1
      ;;
  esac
}

ok_runs() {
  local f
  for f in "$EVAL_STATE/$1"/${2:-}*.jsonl; do
    [ -e "$f" ] || continue
    case ${f##*/} in *probe*) continue ;; esac
    jq -e 'select(.type=="result") | .is_error == false' "$f" >/dev/null 2>&1 && echo "$f"
  done
}

# Original set = flaws without pooled:true; pooled set = all flaws.
score_record() {
  local base score
  base=$(basename "$2" .jsonl)
  score=${2%.jsonl}.score.json
  [ -f "$score" ] || return 1
  jq -c --arg kind "$(<"$EVAL_ROOT/cases/$1/kind")" --arg case "$1" --arg config "${base%-*}" --argjson n "${base##*-}" \
    --slurpfile flaws "$EVAL_ROOT/cases/$1/flaws.json" '
    ($flaws[0]) as $f
    | (.hits | map(tostring)) as $h
    | def found($ids): $ids | map(select(. as $i | $h | any(. == $i))) | length;
      {kind: $kind, case: $case, config: $config, n: $n,
       orig_total: ($f | map(select(.pooled | not)) | length),
       orig_hits: found($f | map(select(.pooled | not) | .id | tostring)),
       pool_total: ($f | length),
       pool_hits: found($f | map(.id | tostring)),
       fps: (.false_positives | length)}' "$score"
}
