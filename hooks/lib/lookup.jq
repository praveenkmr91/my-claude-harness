def is_lookup:
  "(cd\\s+[^&;|]+(&&|;)\\s*)?" as $cd
  | "(for\\s+\\w+\\s+in\\s+[^;]*;\\s*do\\s+)?" as $loop
  | "(echo\\s+(\"[^\"]*\"|'[^']*')\\s*;\\s*)*(echo\\s+\"[^\"$]*\\$\\()?" as $label
  | "([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*" as $env
  | "((grep|rg|find|ls|cat|head|tail|awk|wc|jq|tree|stat)(\\s|$)|sed\\s+-n\\b|git(\\s+--no-pager)?(\\s+-C\\s+\\S+)?\\s+(log|show|diff|blame|grep|status)(\\s|$))" as $read
  | test("^\\s*" + $cd + $loop + $label + $env + $read);
