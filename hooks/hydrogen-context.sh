#!/usr/bin/env bash
IN=$(cat)
case "$IN" in
  *hydrogen*|*Workflow*|*useProcessState*|*ProtectRoutes*|*milestone*|*StepContent*|*ProcessContent*|*ContentBox*|*Accordion*|*ui.layouts*|*keepPreviousData*|*cacheTime*|*staleTime*|*usePortfoliosData*|*useSecurityResearchData*|*useTableControl*|*TableFilter*|*createTableState*|*FieldsType*|*customCells*|*ui.components.table*|*HydrogenForms*|*DecimalInput*|*TextfieldWrap*|*useFieldArray*|*listKeyDataSource*|*eject-script*|*ejected*|*resolve.dedupe*|*@teambit*) ;;
  *) exit 0 ;;
esac

CWD=$(jq -r '.cwd // empty' <<<"$IN")
ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")
grep -qs '@additiv-hydrogen' "$ROOT/package.json" || exit 0
SID=$(jq -r '.session_id // empty' <<<"$IN")
[ -z "$SID" ] && exit 0
REF="${HYDROGEN_REF:-$HOME/.claude/hydrogen-reference.md}"
FLAGS="/tmp/claude-hydrogen-ctx-$SID"
OUT=""

once() { [ -e "$FLAGS-$1" ] && return 1; touch "$FLAGS-$1"; }

case "$IN" in
  *hydrogen-component-map*) ;;
  */projects/hydrogen/hydrogen*|*@additiv-hydrogen*)
    once map && OUT="Hydrogen dive detected. If this is component DISCOVERY (which component/prop/enum exists), read the 288-package map FIRST: ~/Documents/projects/hera/.claude/skills/generate-component-map/assets/hydrogen-component-map.json — shortlist there, then verify the pick against source/installed dist (hydrogen.md §Source-vs-installed). If you are verifying specific behavior, carry on." ;;
esac

inject() {
  once "$1" || return
  local sec
  sec=$(awk -v h="$2" '/^## /{p=index($0,h)==1} p' "$REF")
  [ -z "$sec" ] && return
  OUT="$OUT${OUT:+

}[hydrogen-reference.md — injected once for this session; re-Read the file if this scrolls out]
$sec"
}

case "$IN" in *eject:hydrogen*|*eject-script*|*ejected*|*resolve.dedupe*|*@teambit*) inject ejection '## Ejection' ;; esac
case "$IN" in *StepContent*|*ProcessContent*|*ContentBox*|*Accordion*|*ui.layouts*) inject layouts '## Layouts' ;; esac
case "$IN" in *Workflow*|*useProcessState*|*ProtectRoutes*|*/workflows/*|*milestone*) inject workflows '## Workflows' ;; esac
case "$IN" in *keepPreviousData*|*cacheTime*|*staleTime*|*usePortfoliosData*|*useSecurityResearchData*) inject data '## Data & caching' ;; esac
case "$IN" in *useTableControl*|*TableFilter*|*createTableState*|*FieldsType*|*customCells*|*ui.components.table*) inject tables '## Tables' ;; esac
case "$IN" in *HydrogenForms*|*hydrogen-forms*|*DecimalInput*|*TextfieldWrap*|*useFieldArray*|*listKeyDataSource*) inject forms '## Forms' ;; esac

[ -z "$OUT" ] && exit 0
jq -cn --arg c "$OUT" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
