def is_lookup:
  test("^\\s*(cd\\s+[^&;|]+&&\\s*)?([A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*((grep|rg|find|ls|cat|head|tail|awk|wc|jq|tree|stat)(\\s|$)|sed\\s+-n\\b|git(\\s+--no-pager)?(\\s+-C\\s+\\S+)?\\s+(log|show|diff|blame|grep|status)(\\s|$))");
