#!/bin/bash
# Stop hook, and PreToolUse SendMessage on a `[REPORT` send (window = since the previous sent REPORT, not the typed prompt, so a typed "granted" cannot empty it).
# Claim = first line of the final reply (or the REPORT) only, so "not done yet" in the body never trips it; commit ask = last line; per-lens verdict lines are excluded from both.
# One-shot on Stop: stop_hook_active passes the retry unchecked, except the REVIEW AGENTS NOT RUN check, which runs again on a retry that claims or ships, with no release however many blocks came before; a reply that claims nothing passes. A blocked REPORT re-blocks until it changes.
# Review is owed at the checkpoint only: a done-claim whose first line is not "Step N", a REPORT, or the shipping commit. review-classify.py alone decides what is owed (`required=`, `owed-files=`) from the reviewer runs in the transcript and the files each was shown; this gate clears nothing and blocks while `required=` is non-empty, whatever findings, skip or hand-pass lines the reply holds. A commit or commit ask alone owes no review. A REPORT answering a STOP and a no-code Stop in the window it opened are exempt; a REPORT, and a Stop in a window a REPORT opened, send `review_scope=report`, so the classifier lists only the Big members.
# Claim and evidence checks fire only on turns that edited a code file or got an `implementer` hand-back — answers, commits and doc edits carry no runtime claim. The checkpoint check also runs on every other turn that claims done or sends a REPORT, once the session has made a Write/Edit/MultiEdit to a code file or dispatched an agent. A `Pass: <verb>` line in the reply is checked on every turn.
# A plan build's done-claim or shipping commit also needs one `/learn` pass in the transcript (typed or Skill) or a `learn: skip — <reason>` line: of 84 build sessions, 13 ran /learn (measured 2026-11-06).

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re,subprocess,os,urllib.parse
try: inp=json.loads(sys.argv[1])
except ValueError: sys.exit(0)
if not isinstance(inp,dict): sys.exit(0)
report=inp.get('tool_name')=='SendMessage'
# The header is the first line minus markdown and quote marks, so `**[REPORT d step 1]**` and `[Report …]` are gated; a NOTE that quotes a header later in its text is not.
def is_report(m):
    first=next((l for l in m.split('\n') if l.strip()),'')
    return bool(re.match(r'\[\s*REPORT\b',first.lstrip('*_>#` \t'),re.I))
if report:
    final=inp.get('tool_input',{}).get('message')
    if not (isinstance(final,str) and is_report(final)): sys.exit(0)
path=inp.get('transcript_path')
if not path: sys.exit(0)
label_open=r'^\s*(?:[-*]\s+)?[`*]*'
label_close=r'[`*]*:[`*]*[ \t]*'
skip_reason=r'skip(?:ped)?[ \t]*[—–.:,-][ \t]*\S'
verdict=re.compile(label_open+r'([a-z][a-z-]+)'+label_close+r'(?:(?:\d+|no) findings?\b|('+skip_reason+r')).*$')
def lens_ran(b):
    i=b.get('input',{})
    if b.get('name')=='Skill': return i.get('skill','').split(':')[-1]
    if b.get('name') in ('Agent','Task'): return i.get('subagent_type','').split(':')[-1]
# shortcut: lens and evidence checks are turn-scoped — a plan-file `rm` in one turn with a sha-less (`-q`) commit in the next escapes the shipping check; the review-agent check runs only once this session has Write/Edit-ed code or dispatched an agent, so a claim over an earlier session's unreviewed code, or over code written only by Bash, escapes it; upgrade = size Big by git range across sessions.
def result_text(c): return c if isinstance(c,str) else ' '.join(b.get('text','') for b in c or [] if isinstance(b,dict))
def reset(by_report=False,after_stop=False):
    global texts,cmds,cmd_ids,commit_shas,results,edits,lens_calls,tools,handbacks,verifier_calls,nudged,built,built_blind,hb_at,stopped,feedback_blocks,window_report,stop_window
    texts=[]; cmds=[]; cmd_ids=[]; commit_shas=[]; results={}; edits=[]; lens_calls=[]; tools=[]; handbacks=[]; verifier_calls=[]; nudged=False; built=False; built_blind=False; hb_at=0; stopped=False; feedback_blocks=0; window_report=by_report; stop_window=after_stop
# An Agent dispatch result names the agent's own transcript (`output_file: …/<id>.output`); its Write/Edit calls are the hand-back's edit paths.
agent_out={}
output_file=re.compile(r'output_file:\s*(\S+/([^/\s]+)\.output)')
def agent_edits(p):
    files=[]
    try:
        for l in open(p):
            try: a=json.loads(l)
            except ValueError: continue
            if a.get('type')!='assistant': continue
            for b in a.get('message',{}).get('content') or []:
                if isinstance(b,dict) and b.get('type')=='tool_use' and b.get('name') in ('Write','Edit','NotebookEdit'): files.append(b.get('input',{}).get('file_path') or b.get('input',{}).get('notebook_path') or '')
    except OSError: pass
    return files
def handback(origin):
    global built,built_blind,hb_at
    built=True; hb_at=len(cmds)
    files=agent_edits(agent_out.get(origin.get('from'),''))
    if files: edits.extend(files)
    else: built_blind=True
stop_msg=re.compile(r'<cross-session-message[^>]*>\s*\[STOP\b')
harness=os.path.expanduser('~/.claude/')
reset(); report_ids=set(); commit_ids=set(); last_sha=None; base=None
# Transcript-wide, never reset(): plan edits and their reviews span turns, and session_work must outlive the window so a later claim still owes the session's reviews.
ev=0; plan_edits={}; plan_reviews=[]; errored_ids=set(); advisor_at=[]; learned=False; model=''; session_work=False
code=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
commit_cmd=re.compile(r'\bgit(?:\s+(?:-[Cc]\s+\S+|--?\w[\w-]*(?:=\S+)?))*\s+commit\b')
# The shipping commit deletes the repo plan file (plan-mode.md "The plan is the file"). `ship` reads that from the commits' own diffs; `plan_rm` is the fallback for a commit whose sha was not printed (`git commit -q`).
plan_rm=re.compile(r'\brm\b[^\n;&|]*\bdocs/plans/[^\s;&|]+\.md\b')
plan_deleted=re.compile(r'^D\t(?:.*/)?docs/plans/[^\t]+\.md$',re.M)
commit_line=re.compile(r'^\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]',re.M)
# Twin of the implementer hand-back selects (user and attachment) in hooks/step-gate.sh EVENTS.
try: transcript=open(path)
except OSError: sys.exit(0)
for line in transcript:
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        if '<command-name>/learn</command-name>' in txt: learned=True
        # isMeta = skill bodies, peer hand-backs and this hook's own feedback — not a new prompt, or they reset `ran` and re-trip on the verbs they quote.
        if not report and txt.strip() and not txt.lstrip().startswith('<') and not r.get('isMeta') and not r.get('isCompactSummary'): reset(); base=None
        if r.get('isMeta') and txt.lstrip().startswith('Stop hook feedback:') and 'REVIEW AGENTS NOT RUN' in txt: feedback_blocks+=1
        if isinstance(c,str) and stop_msg.search(c): stopped=True
        if r.get('origin',{}).get('handback') and r['origin'].get('name')=='implementer': handback(r['origin'])
        if isinstance(c,str) and '<agent-message from=' in c: handbacks.append(c)
        if not isinstance(c,str):
            for b in c or []:
                if isinstance(b,dict) and b.get('type')=='tool_result':
                    results[b.get('tool_use_id')]=(b.get('is_error'),result_text(b.get('content')))
                    if b.get('is_error'): errored_ids.add(b.get('tool_use_id'))
                    if b.get('tool_use_id') in commit_ids and not b.get('is_error') and (shas:=commit_line.findall(results[b.get('tool_use_id')][1])): last_sha=shas[-1]; commit_shas.extend(shas)
                    for m in output_file.finditer(results[b.get('tool_use_id')][1]): agent_out[m.group(2)]=m.group(1)
        # A blocked REPORT lands as an errored result and keeps the window, so an unchanged resend blocks again; a pending send has no result yet.
        if not isinstance(c,str) and any(isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id') in report_ids and not b.get('is_error') for b in c or []): reset(True,stopped); base=last_sha
        # A PreToolUse block lands as an errored tool_result, not a hook_blocking_error attachment.
        if not isinstance(c,str) and any(isinstance(b,dict) and b.get('type')=='tool_result' and b.get('is_error') and 'about to write source' in str(b.get('content','')) for b in c or []): nudged=True
    elif t=='attachment':
        origin=r.get('attachment',{}).get('origin',{})
        if stop_msg.search(result_text(r.get('attachment',{}).get('prompt'))): stopped=True
        if origin.get('handback') and origin.get('name')=='implementer': handback(origin)
    elif t=='assistant':
        m=r.get('message',{}).get('model')
        if isinstance(m,str) and m and not m.startswith('<'): model=m
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text':
                texts.append(b['text'])
            if b.get('type') not in ('tool_use','server_tool_use'): continue
            ev+=1
            if b.get('name')=='advisor': advisor_at.append(ev)
            if lens_ran(b)=='learn': learned=True
            if b.get('type')!='tool_use': continue
            tool_in=b.get('input',{})
            if b.get('name') in ('Agent','Task') or (b.get('name') in ('Write','Edit','MultiEdit') and code.search(tool_in.get('file_path') or '')): session_work=True
            if b.get('name') in ('Write','Edit'):
                edited=b.get('input',{}).get('file_path','')
                if re.search(r'/plans/[^/]+\.md$',edited) and not edited.endswith('.research.md'): plan_edits[edited]=ev
            elif b.get('name') in ('Agent','Task') and lens_ran(b)=='cold-reader': plan_reviews.append((ev,b.get('input',{}).get('prompt') or '',b.get('id')))
            message=b.get('input',{}).get('message')
            # A REPORT's `Pass:` and skip lines satisfy the Stop arm after the send.
            if b.get('name')=='SendMessage' and isinstance(message,str) and is_report(message):
                report_ids.add(b.get('id'))
                if not report: texts.append(message)
            if b.get('name')=='Bash':
                cmds.append(b.get('input',{}).get('command','')); cmd_ids.append(b.get('id'))
                if commit_cmd.search(cmds[-1]): commit_ids.add(b.get('id'))
            elif b.get('name') in ('Write','Edit','NotebookEdit'): edits.append(b.get('input',{}).get('file_path',''))
            else:
                if b.get('name') in ('Agent','Task','Skill'): lens_calls.append((b.get('name'),lens_ran(b),b.get('id')))
                tools.append((b.get('name',''),b.get('id')))
                if lens_ran(b)=='browser-verifier': verifier_calls.append(b.get('id'))
def call_ok(i): return i is None or not (results.get(i) or (False,))[0]
ran={l for _,l,i in lens_calls if call_ok(i)}
if not report:
    final=inp.get('last_assistant_message')
    if not isinstance(final,str): final=texts[-1] if texts else ''
# Stop can fire before the final reply is flushed to the transcript, which drops its verdict lines.
if final.strip() and (not texts or texts[-1].strip()!=final.strip()): texts.append(final)
cwd=inp.get('cwd') or ''
warned=[]
# Claude Code drops a hook's stderr on exit 0, so a skipped classify also goes out once as a systemMessage; nothing else here writes stdout.
def classify_skipped(why):
    print(why,file=sys.stderr)
    if not warned: print(json.dumps({'systemMessage':why}))
    warned.append(why)
def classify(report_scope=False):
    verb,lenses,required,owed_files='review','reuse-analyzer,placement-analyzer','none',{}
    if cwd and os.path.isdir(cwd):
        payload=dict(inp)
        if base and code_turn: payload['review_base']=base
        if report_scope: payload['review_scope']='report'
        # Under the 10s Stop-hook timeout in settings.json; a killed hook blocks nothing.
        try:
            res=subprocess.run(['python3',os.path.expanduser('~/.claude/hooks/review-classify.py')],input=json.dumps(payload),cwd=cwd,capture_output=True,text=True,timeout=6)
            joins=res.stdout
            if res.stderr and not re.search(r'code-added=\d+ required=',joins): classify_skipped('review-classify failed: '+res.stderr.splitlines()[0])
        except subprocess.TimeoutExpired:
            classify_skipped('review-classify timed out after 6s; review joins skipped')
            joins=''
        m=re.search(r'verb=(\S+) lenses=(\S+)',joins)
        if m: verb,lenses=m.groups()
        found=re.findall(r'code-added=\d+ required=([^\s>]+)',joins)
        if found: required=found[-1]
        # `high-risk=` prints raw paths ahead of the other keys, so the last match is the classifier's own.
        found=re.findall(r'owed-files=([^\s>]*)',joins)
        for entry in found[-1].split(';') if found else []:
            member,_,listed=entry.partition(':')
            items=listed.split(',')
            owed_files[member]=([urllib.parse.unquote(i) for i in items if not i.startswith('+')],sum(int(i[1:]) for i in items if i.startswith('+')))
    return verb,lenses,required,owed_files
def unshown_line(member,files):
    paths,more=files
    return f"{member} has not been shown: {', '.join(paths)}{f' and {more} more' if more else ''}."
def required_status(required,owed_files):
    if required=='none': return None
    owed=required.split(',')
    block=f"REVIEW AGENTS NOT RUN for {', '.join(owed)}: source written in this session still owes each a run. Run `security-review` as a `Skill` call and the rest as agents, each with an `effort` (~/.claude/review-battery.md says what each is for); a typed findings or skip line does not count. An agent run clears the files its transcript shows; `security-review` clears on its Skill call. Give each everything written since its last run, never the last commit alone."
    return '\n'.join([block]+[unshown_line(m,owed_files[m]) for m in owed if m in owed_files])
problems=[]
# Mirrors the verb table in review-routing.md and review-battery.md — a member renamed there must be renamed here. The verb comes from the reply's `Pass:` line, never the prompt, because a prompt that only discusses a verb is not an ask for it.
NAMED_VERBS={
    'battery':['code-reviewer','silent-failure-hunter','type-design-analyzer','reuse-analyzer','placement-analyzer','comment-analyzer','modern-ts-analyzer'],
    'harden':['adversarial-reviewer','security-review'],
    'trim':['delete-list','simplify','comment-analyzer','modern-ts-analyzer','shortcut-debt'],
}
for verb,members in NAMED_VERBS.items():
    if not re.search(label_open+r'Pass'+label_close+verb+r'\b','\n'.join(texts),re.M|re.I): continue
    missing=[m for m in members if m not in ran and not re.search(label_open+re.escape(m)+label_close+r'not run[ \t]*[—–:-][ \t]*\S','\n'.join(texts),re.M)]
    if missing: problems.append(f"NAMED VERB NOT RUN: this reply announces `Pass: {verb}`, and no Skill/Agent call ran for {', '.join(missing)}. A verdict line does not count here — invoke each member, or write `<member>: not run — <reason>` for each one you are not running.")
if nudged and 'implementer' not in ran and not re.search(label_open+r'implementer'+label_close+r'(?:dispatching\b|'+skip_reason+r')','\n'.join(texts),re.M):
    problems.append("IMPLEMENTER NUDGE UNANSWERED: opus-write-nudge fired this turn and no `implementer` dispatch or verdict line followed. Write `implementer: dispatching` (and dispatch) or `implementer: skip — <reason>`.")
plan_tail=[l for l in final.split('\n') if l.strip() and not verdict.match(l)]
later_approval=r'for your\s+[\'"`“”‘’]?implement\b[\'"`“”‘’]?'
ask_line=re.sub(later_approval,'',plan_tail[-1],flags=re.I) if plan_tail else ''
implement_ask=not report and plan_edits and ask_line and re.search(r'\b(implement|build it|hand (?:it )?to the implementer|start the build)\b',ask_line,re.I) and re.search(r'\?|\btype\b|\bsay\b|approv|go ahead|want me|\bif you\b',ask_line,re.I)
if implement_ask:
    plan_path=max(plan_edits,key=plan_edits.get)
    plan_name=os.path.basename(plan_path)
    # The basename matches only as a whole path component, so a read of `build-ui.md` is not one of `ui.md`; the basename alone still follows a plan moved between `plans/` dirs.
    named_in=re.compile(r'(?:^|[/\s`"\'(])'+re.escape(plan_name)+r'\b')
    covering=[e for e,prompt,i in plan_reviews if i not in errored_ids and (plan_path in prompt or named_in.search(prompt))]
    unreviewed=[]
    if not covering: unreviewed.append('(A) no cold-reader ran on it')
    if covering and 'fable' not in model.lower() and not any(a>covering[0] for a in advisor_at): unreviewed.append('(B) no advisor consult followed its first review')
    if unreviewed: problems.append(f"PLAN PRESENTED UNREVIEWED: this reply asks to implement {plan_name}, but {' and '.join(unreviewed)} (plan-build.md Review). Run the missing review, fold it, then present.")
# A redirect counts by its target only: `node --test x.test.js > out.txt` names code but writes none.
redirect_target=re.compile(r'(?:>>?|\btee(?:\s+-a)?)\s*([^\s;&|]+)')
inplace_write=re.compile(r'sed -i|write_text')
def writes_code(c): return any(code.search(t) for t in redirect_target.findall(c)) or bool(inplace_write.search(c) and code.search(c))
if report and '/scratchpad/' not in final:
    problems.append("REPORT WITHOUT RAW OUTPUT: a REPORT names the scratchpad file holding the last 20 lines of each check (peer-sessions.md); run the checks in this thread and cite it.")
# A commit counts in command position only, whatever its result: `git commit -q` prints no sha, so an errored `-q … && false` may have landed. shortcut: quotes are not parsed, so `grep -E 'a|git commit'` counts as a commit; upgrade = a shell tokenizer if those blocks show up.
# commit_at's value and path classes stop at a separator and a quote, so each token parses one way; otherwise a long command backtracks past the Stop timeout.
commit_at=re.compile(r'(?:^|[;&|({`]|\b(?:ba|z)?sh\s+-\w*c\s+[\'"]|\beval\s+[\'"]?)\s*(?:(?:(?:time|then|do|if|elif|else|while|until|env|command|exec|nice)|!|xargs(?:\s+-[^\s;&|`]+)*|timeout\s+[^\s;&|`]+|\w+=(?:"[^"]*"|\'[^\']*\'|[^\s;&|`\'"]*))\s+)*(?:[^\s;&|`]*/)?'+commit_cmd.pattern,re.M)
committed=any(commit_at.search(c) for c in cmds)
# None = the commits' diffs could not be read: a timeout, a git error, or no sha printed.
def commits_delete_plan():
    if not (commit_shas and cwd and os.path.isdir(cwd)): return None
    try: shown=subprocess.run(['git','-c','core.quotepath=off','log','--no-walk=unsorted','--ignore-missing','--no-renames','--name-status','--diff-filter=D','--format=',*commit_shas,'--'],cwd=cwd,capture_output=True,text=True,timeout=3)
    except (subprocess.TimeoutExpired,OSError): return None
    if shown.returncode: return None
    return bool(plan_deleted.search(shown.stdout))
plan_deleted_by_commit=commits_delete_plan() if committed else False
ship=committed and (bool(plan_deleted_by_commit) or any(plan_rm.search(c) for c in cmds))
commit_unread=committed and plan_deleted_by_commit is None
code_turn=built or ship or any(code.search(e) for e in edits) or any(writes_code(c) for c in cmds)
agent_ran=any(n in ('Agent','Task') for n,_,_ in lens_calls)
lines=[l for l in final.split('\n') if l.strip() and not verdict.match(l)]
first=lines[0] if lines else ''
last=lines[-1] if lines else ''
commit_ask=re.search(r'\bcommit(?!ted)',last,re.I) and re.search(r'\?|\bsay\b|approv|go ahead|want me',last,re.I)
# Off a code or agent turn only done, complete and ready to ship count, and a hedge anywhere in the clause voids it ("Not quite done.", "what's done and what's left:"); "done-claim" is a name. shortcut: clauses split at . ! ? ; : — but not at commas, bar a trailing commit ask (below); upgrade = split commas once a suppressed real claim is seen.
complete=r"(?:\bis|\bare|['’](?:s|re))\s+(?:\w+\s+)?complete\b"
claim_words=r'done(?!-)|fixed|works|passes|passing|green|ready to (?:ship|commit|merge)' if code_turn or agent_ran else r'done(?!-)|ready to (?:ship|commit|merge)'
claim_word_re=re.compile(r'(?<!not )(?<!fix )(?<!review )(?<!sweep )\b(?:'+claim_words+r')\b|'+complete,re.I)
hedge=re.compile(r"\b(?:not|yet|almost|nearly|partly|partially|to be)\b|n['’]t\b|\bwhat['’]s\b",re.I)
narrow=not (code_turn or agent_ran)
# A clause ending in "?" is a question, not a claim, except a claim ahead of a trailing commit ask after its last comma ("Fixed it and tests pass, commit?") whose head is not itself a question or a condition ("Is it done, should I commit?", "If that works, should I commit?").
commit_tail=re.compile(r',[^,?]*\bcommit(?!ted)[^,?]*\?$',re.I)
question_head=re.compile(r"\W*(?:is|are|was|were|did|does|do|has|have|can|could|should|would|will|shall|want|if|once|when|after|assuming|unless|provided|whether)\b",re.I)
def clause_claim(clause):
    if clause.endswith('?'):
        head=commit_tail.sub('',clause)
        if head==clause or question_head.match(head): return None
        clause=head
    if narrow and hedge.search(clause): return None
    return claim_word_re.search(clause)
claim=next((m for clause in re.findall(r'[^.!?;:—]+[.!?;:—]?',first) if (m:=clause_claim(clause))),None)
# A first line opening "Step N" claims one plan step, which owes no review (review-routing.md); the whole build's claim and the shipping commit are the checkpoint.
step_claim=re.match(r'\W*step\s+\d+\b',first,re.I)
step_turn=bool(step_claim) and not ship and not commit_unread
stop_exempt=window_report and stop_window and not report and not code_turn
if inp.get('stop_hook_active') and not report:
    # A step claim is exempt here only as it was on the first run: once an agent block is in the window, rewording to "Step N" must not pass.
    step_exempt=bool(step_claim) and not (ship or commit_unread or feedback_blocks)
    if not step_exempt and not stop_exempt and (claim or ship):
        _,_,required,owed_files=classify(window_report)
        block=required_status(required,owed_files)
        if block:
            print(block,file=sys.stderr)
            sys.exit(2)
    sys.exit(0)
# A REPORT answering a STOP skips every check but `problems` (raw-output path, `Pass:` lines, plan gate); a no-code Stop in the window it opened skips the review-agent check too, until a typed prompt or the next REPORT.
if (report and stopped) or not code_turn:
    if not (report and stopped) and not stop_exempt and not step_turn and session_work and (claim or report):
        _,_,required,owed_files=classify(report or window_report)
        block=required_status(required,owed_files)
        if block: problems.append(block)
    if problems:
        print('\n'.join(problems),file=sys.stderr)
        sys.exit(2)
    sys.exit(0)
# A REPORT's skip lines come from the message being sent: chat text earlier in the window is not what the planner reads.
all_lines=[l for l in '\n'.join([final] if report else texts).split('\n') if l.strip()]
skipped={m.group(1) for l in all_lines if (m:=verdict.match(l)) and m.group(2)}
claim_word=claim.group(0) if claim else 'REPORT' if report else None
why='claims done' if claim_word else 'asks to commit' if commit_ask else 'ran git commit'
# Command position only: a bare word match passes on `grep eslint package.json` or `git log --grep verify`.
# Each token must parse one way (a flag value is never `run`/`exec`; `--f` splits one way), or backtracking outlives the Stop timeout and the gate fails open.
# Twin: hooks/step-gate.sh CHECK is a superset (test runners, mobile analyzers); change the shared core in both, never copy its extras here.
static_check=re.compile(r'(?:^|[;&|(]\s*)(?:(?:command|time|env(?:\s+\w+=\S*)*|if|then|!)\s+)?(?:\w+=\S*\s+)*(?:'
    r'(?:pnpm|npm|yarn|bun|npx|bunx)(?:\s+(?:run|exec|-{1,2}\w[\w-]*(?:=\S+)?(?:\s+(?!(?:run|exec)\s)[^\s;&|-]\S*)?))*\s+'
    r'(?:(?:nx|turbo|ng|workspace\s+\S+)(?:\s+(?:run|exec|-{1,2}\w[\w-]*(?:=\S+)?(?:\s+(?!(?:run|exec)\s)[^\s;&|-]\S*)?))*\s+)?[\w:.-]*(?:lint|tsc|typecheck|type-check|check:types?|ts:check|verify)[\w:.-]*'
    r'|(?:\S*/)?(?:eslint|oxlint|tsc|vue-tsc))(?:@\S+)?(?=\s|$|[;&|)])',re.I|re.M)
evidence=re.compile(r'\b(pnpm|npm|yarn|bun)\s+(run\s+)?(verify|test|e2e)|vitest|playwright|node --test|curl\s|http://localhost',re.I)
# Twin of the step-line format bullet in agents/browser-verifier.md.
step_line=re.compile(r'^\s*\d+\.\s.*—\s*(pass|fail|blocked)\s*—',re.M)
agent_id=re.compile(r'agentId:\s*(\S+)')
verifier_ids={m.group(1) for i in verifier_calls if (m:=agent_id.search((results.get(i) or (None,''))[1]))}
verifier_passed=any(any(f'<agent-message from="{a}"' in h for a in verifier_ids) and (steps:=step_line.findall(h)) and all(s=='pass' for s in steps) for h in handbacks)
browser_run=any(n.startswith(('mcp__chrome-devtools__','mcp__playwright__')) and not (results.get(i) or (False,))[0] for n,i in tools) or verifier_passed
# A pipe into grep/tail exits 0 over a red suite, so the runner's own fail markers count as much as the exit code.
fail_marker=re.compile(r'ℹ fail [1-9]|^# fail [1-9]|^not ok \d|^\s*(?:×\s*)?FAIL\s|\b[1-9]\d* failed\b',re.M)
def failed(res): return bool(res) and ((res[0] and res[1].startswith('Exit code')) or bool(fail_marker.search(res[1])))
# Runtime and static runs stay two lists: the last of either failing fails the claim, so a green lint cannot hide a red test.
# A REPORT counts the commands after the last implementer hand-back; checks that ran before the build say nothing about it.
fresh=list(zip(cmd_ids,cmds))[hb_at if report else 0:]
runtime_ids=[i for i,c in fresh if evidence.search(c)]
static_ids=[i for i,c in fresh if report and static_check.search(c)]
evidence_ids=runtime_ids+static_ids
report_tail='; for a REPORT, the raw output of the checks goes in the message itself' if report else ''
no_evidence_close="run the step's → verify lines in this thread and cite their output" if report else 'or reword the first line as a status, not a claim'
no_check='no check ran since the last REPORT' if report else 'no test or runtime command ran this turn — static-clean (lint + tsc) is not done'
failed_run_close="; a REPORT cannot be reworded — if the plan step expects this failure, add an `expected red: <what fails and why the plan expects it>` line, which the planner checks against the plan" if report else ', or reword the first line as a status that names what is still red'
# A fail-first step's REPORT is red by design; the planner checks the stated reason against the plan and the raw output.
def expected_red():
    label=re.search(label_open+r'expected red'+label_close+r'(.+)$',final,re.I|re.M) if report else None
    return bool(label) and len(label.group(1).split())>=4
if claim_word and not browser_run and not evidence_ids:
    problems.append("DONE-CLAIM WITHOUT EVIDENCE: the first line claims "+repr(claim_word)+" but "+no_check+". Exercise the change (tests, Playwright, curl, browser) and report the output, "+no_evidence_close+report_tail+".")
elif claim_word and any(failed(results.get(ids[-1])) for ids in ((static_ids,) if expected_red() else (runtime_ids,static_ids)) if ids):
    problems.append("DONE-CLAIM OVER A FAILED RUN: the first line claims "+repr(claim_word)+" but the last test or runtime command this turn failed (non-zero exit or a runner fail marker in its output). Fix the failures and rerun until green"+failed_run_close+report_tail+".")
web=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte)\b')
def has_lint_script(d):
    try: return any(re.search(r'lint|typecheck|type-check|tsc',k) for k in json.load(open(os.path.join(d,'package.json'))).get('scripts',{}))
    except (OSError,ValueError): return False
# A hand-back whose agent transcript cannot be read leaves the window blind, so the repo decides: lint is required only where the cwd's package.json defines a lint or type-check script.
def repo_lints(cwd):
    if not (cwd and os.path.isdir(cwd)): return False
    if has_lint_script(cwd): return True
    try: top=subprocess.run(['git','rev-parse','--show-toplevel'],cwd=cwd,capture_output=True,text=True,timeout=3).stdout.strip()
    except subprocess.TimeoutExpired: return False
    return bool(top) and has_lint_script(top)
# A REPORT reads the same post-hand-back slice as its evidence: a lint from before the last build says nothing about it.
lint_cmds=[c for _,c in fresh] if report else cmds
if (claim_word or commit_ask or committed) and ((built_blind and repo_lints(cwd)) or any(web.search(e) and not e.startswith(harness) for e in edits)) and not any(static_check.search(c) for c in lint_cmds):
    problems.append(f"LINT/TSC NOT RUN: this turn edited web code and {why}, and no lint or type-check command ran. Run them and report the output (CLAUDE.md: run linter + type checker).")
if claim_word or ship:
    _,lenses,required,owed_files=classify(report or window_report)
    if 'impeccable' in lenses.split(',') and 'impeccable' not in ran:
        problems.append("IMPECCABLE NOT RUN: this turn changed styling; run the `impeccable:impeccable` skill with `audit <changed files>` — a hand-written findings or skip line never satisfies it (review-routing.md).")
    owed_block=None if step_turn else required_status(required,owed_files)
    if owed_block: problems.append(owed_block)
strict=(built and claim and not step_claim and not report) or ship
if strict and not learned and 'learn' not in skipped:
    problems.append("LEARN NOT RUN: this plan build claims done or ships, and `/learn` has not run in this session. Run the `learn` skill on this build (it writes only on a yes), or write `learn: skip — <reason>`.")
if problems:
    print('\n'.join(problems),file=sys.stderr)
    sys.exit(2)
PY
