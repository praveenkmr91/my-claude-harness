def typed_text:
  select(.type? == "user" and (.isMeta | not) and (.isCompactSummary | not)) | .message.content
  | if type == "string" then . else ([.[]? | select(.type? == "text") | .text] | join(" ")) end
  | select(length > 0 and ((test("^\\s*<") | not) or test("^\\s*<pasted_content")));

def assistant_text:
  select(.type? == "assistant") | [.message.content[]? | select(.type? == "text") | .text] | join(" ")
  | select(length > 0);
