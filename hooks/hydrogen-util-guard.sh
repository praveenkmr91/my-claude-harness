#!/usr/bin/env bash
IN=$(cat)
F=$(jq -r '.tool_input.file_path // empty' <<<"$IN")
case "$F" in
  *.test.*|*.spec.*|*__tests__*|*__mocks__*|*.stories.*) exit 0 ;;
  *.ts|*.tsx|*.js|*.jsx) ;;
  *) exit 0 ;;
esac
CWD=$(jq -r '.cwd // empty' <<<"$IN")
ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || echo "$CWD")
grep -qs '@additiv-hydrogen' "$ROOT/package.json" || exit 0
TXT=$(jq -r '.tool_input.content // .tool_input.new_string // empty' <<<"$IN")
[ -z "$TXT" ] && exit 0

HITS=""
add() { HITS="$HITS\n- $1"; }
grep -q 'Intl\.NumberFormat' <<<"$TXT" && add "Intl.NumberFormat → formatNumberCurrencyDisplay or t('{{val, currency(XXX)}}')"
grep -qE 'Intl\.DateTimeFormat|toLocaleDateString|toLocaleTimeString|toLocaleString' <<<"$TXT" && add "Intl.DateTimeFormat / toLocale*() → formatLocaleDate (core.i18n)"
grep -q '\.toFixed(' <<<"$TXT" && add ".toFixed() → truncateDecimalNumber; if this is money math, PreciseCalc"
grep -qE 'toISOString\(\)\s*\.\s*(slice|split|substring)' <<<"$TXT" && add "toISOString().slice/split → convertToISOString / toUTCFormat"
grep -qE "import[^;]*\bformat\b[^;]*from ['\"]date-fns" <<<"$TXT" && add "date-fns format → formatLocaleDate (pure date arithmetic like addMonths/isBefore is fine)"
grep -qE '(function |const )(debounce|throttle|cloneDeep|groupBy|chunk|uniqBy|deepEqual)\b' <<<"$TXT" && add "hand-rolled lodash-shape helper → core.utils.base already ships these"
[ -z "$HITS" ] && exit 0

printf 'Hand-rolled util(s) in %s where a Hydrogen wrapper exists — the wrapper carries locale/precision wiring the raw call loses (hydrogen.md §Reuse hierarchy):%b\nSwap to the wrapper, or state explicitly why this case is outside its scope.\n' "$(basename "$F")" "$HITS" >&2
exit 2
