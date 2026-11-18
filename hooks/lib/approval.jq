include "turns";

def approving_clause:
  test("^\\s*(?:(?:yes|ok|okay|approved|sure|go ahead and|go ahead|now|so|please|pls|proceed to|let[\u0027\u2019]?s)\\b[\\s,.!-]*)*(?:implement|build|start(?=\\s*$|\\s+(?:impl\\w*|building|coding|now|it\\b|step|chunk|\\d))|(?:follow(?=.*\\binstr\\w*)|take\\s+instr\\w*\\s+from)\\s+(?:(?:the\\s+)?(?:peer|other|that)\\s+session|(?:(?:the|peer|other)\\s+)*(?:session\\s+)?(?-i:(?![A-Z]{2,}-\\d+\\b))\\S*[-_0-9]\\S*))\\b"; "i")
  and (test("\\b(?:didn|don|doesn|won|isn|shouldn)[\u0027\u2019]?t\\b|\\b(?:not|never|why|later|yet|until)\\b"; "i") | not);

def approves:
  (test("\\b(?:ask (?:for )?my approval|until i approve|wait for my (?:approval|go|ok|yes))\\b"; "i") | not)
  and (test("<agent-message\\b") | not)
  and ([splits("\n|(?<=[.!?;])\\s+") | select(test("\\?\\s*$") | not) | splits("[,:]|\\s+(?:and|then)\\s+"; "i") | select(approving_clause)] | length > 0);

# Reads the transcript from `inputs` (run with -nR): the last edited plans/*.md path while no typed approval has followed it, else nothing.
def unapproved_plan:
  reduce (inputs | fromjson?) as $e ({plan: null, approved: false, approvedPlans: []};
    if $e.type? == "assistant" then
      ([$e.message.content[]? | select(.type? == "tool_use" and (.name == "Write" or .name == "Edit"))
        | .input.file_path // empty
        | select(test("/plans/[^/]+\\.md$") and (test("\\.research\\.md$") | not))] | last) as $edited
      | if $edited then .plan = $edited | .approved = (.approvedPlans | index([$edited | sub(".*/"; "")]) != null) else . end
    elif .plan and ([$e | typed_text | select(approves)] | length) > 0 then .approved = true | .approvedPlans += [.plan | sub(".*/"; "")]
    else . end)
  | select(.plan and (.approved | not)) | .plan;
