#!/bin/bash
# Stop hook, and PreToolUse SendMessage on a `[REPORT` send (window = since the previous sent REPORT, not the typed prompt, so a typed "granted" cannot empty it).
# Claim = first line of the final reply (or the REPORT) only, so "not done yet" in the body never trips it; commit ask = last line; per-lens verdict lines are excluded from both.
# One-shot on Stop: stop_hook_active passes the retry unchecked, so the block message must carry the exact verdict format; a blocked REPORT re-blocks until it changes.
# Claim and lens checks fire only on turns that edited a code file or got an `implementer` hand-back — answers, commits and doc edits carry no runtime claim. A `Pass: <verb>` line in the reply is checked on every turn.
# A plan build's done-claim or shipping commit also needs one `/learn` pass in the transcript (typed or Skill) or a `learn: skip — <reason>` line: of 84 build sessions, 13 ran /learn (measured 2026-11-06).

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re,subprocess,os
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
elif inp.get('stop_hook_active'): sys.exit(0)
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
# shortcut: turn-scoped — edits in one turn and the commit ask in a later turn escape the review check, and a plan-file `rm` in one turn with its commit in the next escapes the shipping check; upgrade = scope to edits since the last commit.
def result_text(c): return c if isinstance(c,str) else ' '.join(b.get('text','') for b in c or [] if isinstance(b,dict))
def reset():
    global texts,cmds,cmd_ids,results,edits,ran,tools,handbacks,verifier_calls,nudged,built,built_blind,hb_at,stopped
    texts=[]; cmds=[]; cmd_ids=[]; results={}; edits=[]; ran=set(); tools=[]; handbacks=[]; verifier_calls=[]; nudged=False; built=False; built_blind=False; hb_at=0; stopped=False
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
# Plan-review tracking is transcript-wide and never reset(): plan edits and their reviews span turns.
ev=0; plan_edits={}; plan_reviews=[]; advisor_at=[]; learned=False; model=''
commit_cmd=re.compile(r'\bgit(?:\s+(?:-[Cc]\s+\S+|--?\w[\w-]*(?:=\S+)?))*\s+commit\b')
# The shipping commit deletes the repo plan file (plan-mode.md "The plan is the file").
plan_rm=re.compile(r'\brm\b[^\n;&|]*\bdocs/plans/[^\s;&|]+\.md\b')
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
        if isinstance(c,str) and stop_msg.search(c): stopped=True
        if r.get('origin',{}).get('handback') and r['origin'].get('name')=='implementer': handback(r['origin'])
        if isinstance(c,str) and '<agent-message from=' in c: handbacks.append(c)
        if not isinstance(c,str):
            for b in c or []:
                if isinstance(b,dict) and b.get('type')=='tool_result':
                    results[b.get('tool_use_id')]=(b.get('is_error'),result_text(b.get('content')))
                    if b.get('tool_use_id') in commit_ids and not b.get('is_error') and (shas:=commit_line.findall(results[b.get('tool_use_id')][1])): last_sha=shas[-1]
                    for m in output_file.finditer(results[b.get('tool_use_id')][1]): agent_out[m.group(2)]=m.group(1)
        # A blocked REPORT lands as an errored result and keeps the window, so an unchanged resend blocks again; a pending send has no result yet.
        if not isinstance(c,str) and any(isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id') in report_ids and not b.get('is_error') for b in c or []): reset(); base=last_sha
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
            if b.get('type')=='text': texts.append(b['text'])
            if b.get('type') not in ('tool_use','server_tool_use'): continue
            ev+=1
            if b.get('name')=='advisor': advisor_at.append(ev)
            if lens_ran(b)=='learn': learned=True
            if b.get('type')!='tool_use': continue
            if b.get('name') in ('Write','Edit'):
                edited=b.get('input',{}).get('file_path','')
                if re.search(r'/plans/[^/]+\.md$',edited) and not edited.endswith('.research.md'): plan_edits[edited]=ev
            elif b.get('name') in ('Agent','Task') and lens_ran(b) in ('cold-reader','dry-runner'): plan_reviews.append((ev,b.get('input',{}).get('prompt') or ''))
            message=b.get('input',{}).get('message')
            # A REPORT's lens and skip lines satisfy the Stop arm after the send.
            if b.get('name')=='SendMessage' and isinstance(message,str) and is_report(message):
                report_ids.add(b.get('id'))
                if not report: texts.append(message)
            if b.get('name')=='Bash':
                cmds.append(b.get('input',{}).get('command','')); cmd_ids.append(b.get('id'))
                if commit_cmd.search(cmds[-1]): commit_ids.add(b.get('id'))
            elif b.get('name') in ('Write','Edit','NotebookEdit'): edits.append(b.get('input',{}).get('file_path',''))
            else:
                ran.add(lens_ran(b)); tools.append((b.get('name',''),b.get('id')))
                if lens_ran(b)=='browser-verifier': verifier_calls.append(b.get('id'))
if not report:
    final=inp.get('last_assistant_message')
    if not isinstance(final,str): final=texts[-1] if texts else ''
# Stop can fire before the final reply is flushed to the transcript, which drops its verdict lines.
if final.strip() and (not texts or texts[-1].strip()!=final.strip()): texts.append(final)
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
if implement_ask and not re.search(label_open+r'plan gate'+label_close+skip_reason,'\n'.join(texts),re.M|re.I):
    plan_path=max(plan_edits,key=plan_edits.get)
    plan_name=os.path.basename(plan_path)
    covering=[e for e,prompt in plan_reviews if plan_path in prompt or plan_name in prompt]
    unreviewed=[]
    if not any(e>plan_edits[plan_path] for e in covering): unreviewed.append('(A) no cold-reader or dry-runner ran on it after its last edit')
    if covering and 'fable' not in model.lower() and not any(a>covering[0] for a in advisor_at): unreviewed.append('(B) no advisor consult followed its first review')
    if unreviewed: problems.append(f"PLAN PRESENTED UNREVIEWED: this reply asks to implement {plan_name}, but {' and '.join(unreviewed)} (plan-mode.md Review). Run the missing review, fold it, then present — or write `plan gate: skip — <reason>`.")
code=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
# A redirect counts by its target only: `node --test x.test.js > out.txt` names code but writes none.
redirect_target=re.compile(r'(?:>>?|\btee(?:\s+-a)?)\s*([^\s;&|]+)')
inplace_write=re.compile(r'sed -i|write_text')
def writes_code(c): return any(code.search(t) for t in redirect_target.findall(c)) or bool(inplace_write.search(c) and code.search(c))
if report and '/scratchpad/' not in final:
    problems.append("REPORT WITHOUT RAW OUTPUT: a REPORT names the scratchpad file holding the last 20 lines of each check (peer-sessions.md); run the checks in this thread and cite it.")
# A REPORT answering a STOP says where the builder stopped, so only its raw-output path is required.
committed=any(commit_cmd.search(c) for c in cmds)
ship=committed and any(plan_rm.search(c) for c in cmds)
if (report and stopped) or not (built or ship or any(code.search(e) for e in edits) or any(writes_code(c) for c in cmds)):
    if problems:
        print('\n'.join(problems),file=sys.stderr)
        sys.exit(2)
    sys.exit(0)
# A REPORT's lens lines come from the message being sent: chat text earlier in the window is not what the planner reads.
all_lines=[l for l in '\n'.join([final] if report else texts).split('\n') if l.strip()]
verdicts={m.group(1) for l in all_lines if (m:=verdict.match(l))}
skipped={m.group(1) for l in all_lines if (m:=verdict.match(l)) and m.group(2)}
lines=[l for l in final.split('\n') if l.strip() and not verdict.match(l)]
first=lines[0] if lines else ''
last=lines[-1] if lines else ''
claim=None if first.rstrip().endswith('?') else re.search(r'(?<!not )(?<!fix )(?<!review )(?<!sweep )\b(done|fixed|works|passes|passing|green|ready to (ship|commit|merge))\b',first,re.I)
claim_word=claim.group(0) if claim else 'REPORT' if report else None
commit_ask=re.search(r'\bcommit(?!ted)',last,re.I) and re.search(r'\?|\bsay\b|approv|go ahead|want me',last,re.I)
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
report_tail='; for a REPORT, the lens lines go in the message itself' if report else ''
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
cwd=inp.get('cwd') or ''
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
if claim_word or commit_ask or committed:
    verb,lenses='review','reuse-analyzer,placement-analyzer'
    if cwd and os.path.isdir(cwd):
        # Under the 10s Stop-hook timeout in settings.json; a killed hook blocks nothing.
        try: joins=subprocess.run(['bash',os.path.expanduser('~/.claude/hooks/review-classify.sh')],input=json.dumps(dict(inp,review_base=base) if base else inp),cwd=cwd,capture_output=True,text=True,timeout=6).stdout
        except subprocess.TimeoutExpired: joins=''
        m=re.search(r'verb=(\S+) lenses=(\S+)',joins)
        if m: verb,lenses=m.groups()
    # A first line opening "Step N" claims one plan step, whose done bar is a hand pass (review-routing.md); the whole build's claim and the shipping commit need real lenses.
    step_claim=re.match(r'\W*step\s+\d+\b',first,re.I)
    strict=(built and claim and not step_claim and not report) or ship
    def lens_done(l):
        if l=='impeccable': return l in ran
        if strict: return l in ran or l in skipped
        if report and built: return l in verdicts
        return l in ran or l in verdicts
    missing=[l for l in lenses.split(',') if not lens_done(l)]
    if 'impeccable' in missing:
        missing.remove('impeccable')
        problems.append("IMPECCABLE NOT RUN: this turn changed styling; run the `impeccable:impeccable` skill with `audit <changed files>` — a hand-written findings or skip line never satisfies it (review-routing.md).")
    hand_pass='; on a done-claim or shipping commit in a plan build a hand pass does not count: dispatch the lens or decline it with a reason' if strict else ''
    if missing: problems.append(f"REVIEW NOT RUN for {', '.join(missing)}: this turn edited code and {why}, and the `{verb}` pass names those lenses. Per lens, run it (skill/agent) or hand-pass it and write `<lens>: N findings`, or decline with `<lens>: skip — <reason>` (~/.claude/review-routing.md){hand_pass}{report_tail}.")
    if strict and not learned and 'learn' not in skipped:
        problems.append("LEARN NOT RUN: this plan build claims done or ships, and `/learn` has not run in this session. Run the `learn` skill on this build (it writes only on a yes), or write `learn: skip — <reason>`.")
if problems:
    print('\n'.join(problems),file=sys.stderr)
    sys.exit(2)
PY
