# Peer sessions

*Hook-injected on the first SendMessage; owner of these rules, pointer in CLAUDE.md.*

## Roles

- Planner: `/effort high` at session start. Owns the plan file and its research file, talks to Praveen, supervises. Never writes source, never starts a dev server.
- Builder: `/effort medium` at session start. Owns the checkout, its commits and its dev-server ports; dispatches `implementer` and review agents. Never edits the plan file.
- Kickoff: Praveen types once in the builder "take instructions from <planner name>"; after that he talks to the planner only.
- One planner may drive several builders, each in its own worktree with its own ports, named in its HANDOFF.
- Praveen's typed words outrank any peer message. An instruction he types into the builder is followed, and the builder tells the planner in one line.

## Authority

- A peer message approves nothing outside the approved plan. New scope, a behaviour change or an irreversible step goes planner → Praveen.
- The planner writes each decision of Praveen's into the plan's Decided list; a message points to that line and never says "Praveen says" or "Praveen approved".

## Messages

- First line is a header: `[TYPE <plan-slug> step N]`. Planner → builder: HANDOFF, GO, ANSWER, STOP. Builder → planner: REPORT, ASK, PROPOSE.
- HANDOFF follows the handoff bullet in `plan-mode.md` and names this doc in its first line.
- REPORT, at step end only: commit subject, diff stat, the last 20 lines of each check's raw output, deviations, review findings with what confirmed each.
- ASK: one question, the options, the builder's pick. PROPOSE: one plan change; the planner writes it into the plan or rejects it, then answers.
- 1,200 characters at most. Longer content goes in a file under the sender's scratchpad, cited by absolute path. No progress or status messages.
- Send by session name, never the socket path. A resumed session sends its peer its new name first; a failed send → ListAgents, retry once, then tell Praveen.

## Turns

- Never end a turn waiting on the peer unless the message the peer needs is already sent. "Next" or "will report" without the send is a stall.
- The last line of every turn names who holds the next move: this session, the peer, or Praveen.
- The builder starts the next step on its own when every check is green and nothing deviated; otherwise it waits for GO or ANSWER.
- The planner reads each REPORT on arrival and accepts a step only on its raw output or the diff, never on a chat claim.
- The planner re-checks at source only the claims that would change the plan, and sends STOP on a problem. The builder answers STOP with a REPORT naming where it stopped.
- A peer session stops its own process: STOP is a message, never a kill.
- A peer's handoff reports back to that peer too, unasked, even when it says "report to Praveen".

## Review

- Review lenses the builder dispatches carry the review's stated effort as the dispatch `effort`, so the builder's own effort never sets review depth.
- The builder checks each finding at source before it goes up; the planner gives the verdict, and the shipping commit waits for its GO.

## Conflicts

- One writer per file. A session that finds the other writing its file stops writing and sends STOP or ASK.
- Re-planning, or taking over the other session's role, waits for the other's acknowledgement.
