#!/bin/bash
# Stop hook, and PreToolUse SendMessage on a `[REPORT` send (window = since the previous sent REPORT, not the typed prompt, so a typed "granted" cannot empty it).
# Claim = first line of the final reply (or the REPORT) only, so "not done yet" in the body never trips it; commit ask = last line; per-lens verdict lines are excluded from both.
# One-shot: stop_hook_active passes the retry unchecked, so the block message must carry the exact verdict format.
# Claim and lens checks fire only on turns that edited a code file or got an `implementer` hand-back — answers, commits and doc edits carry no runtime claim. A `Pass: <verb>` line in the reply is checked on every turn.

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re,subprocess,os
inp=json.loads(sys.argv[1])
report=inp.get('tool_name')=='SendMessage'
if report:
    final=inp.get('tool_input',{}).get('message')
    if not (isinstance(final,str) and final.lstrip().startswith('[REPORT')): sys.exit(0)
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
# shortcut: turn-scoped — edits in one turn and the commit ask in a later turn escape the review check; upgrade = scope to edits since the last commit.
def result_text(c): return c if isinstance(c,str) else ' '.join(b.get('text','') for b in c or [] if isinstance(b,dict))
def reset():
    global texts,cmds,cmd_ids,results,edits,ran,tools,handbacks,verifier_calls,nudged,built
    texts=[]; cmds=[]; cmd_ids=[]; results={}; edits=[]; ran=set(); tools=[]; handbacks=[]; verifier_calls=[]; nudged=False; built=False
harness=os.path.expanduser('~/.claude/')
harness_plan=re.compile(r'(?:'+re.escape(harness)+r'|~/\.claude/)plans/[^/\s]+\.md')
reset(); report_ids=set(); harness_build=False
for line in open(path):
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        # isMeta = skill bodies, peer hand-backs and this hook's own feedback — not a new prompt, or they reset `ran` and re-trip on the verbs they quote.
        if not report and txt.strip() and not txt.lstrip().startswith('<') and not r.get('isMeta'): reset()
        # Twin of hooks/step-gate.sh:26-27.
        if r.get('origin',{}).get('handback') and r['origin'].get('name')=='implementer': built=True
        if isinstance(c,str) and '<agent-message from=' in c: handbacks.append(c)
        if not isinstance(c,str):
            for b in c or []:
                if isinstance(b,dict) and b.get('type')=='tool_result': results[b.get('tool_use_id')]=(b.get('is_error'),result_text(b.get('content')))
        # A blocked REPORT lands as an errored result and keeps the window, so an unchanged resend blocks again; a pending send has no result yet.
        if report and not isinstance(c,str) and any(isinstance(b,dict) and b.get('type')=='tool_result' and b.get('tool_use_id') in report_ids and not b.get('is_error') for b in c or []): reset()
        # A PreToolUse block lands as an errored tool_result, not a hook_blocking_error attachment.
        if not isinstance(c,str) and any(isinstance(b,dict) and b.get('type')=='tool_result' and b.get('is_error') and 'about to write source' in str(b.get('content','')) for b in c or []): nudged=True
    elif t=='attachment':
        origin=r.get('attachment',{}).get('origin',{})
        if origin.get('handback') and origin.get('name')=='implementer': built=True
    elif t=='assistant':
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text': texts.append(b['text'])
            if b.get('type')!='tool_use': continue
            message=b.get('input',{}).get('message')
            # A REPORT's lens and skip lines satisfy the Stop arm after the send.
            if b.get('name')=='SendMessage' and isinstance(message,str) and message.lstrip().startswith('[REPORT'):
                report_ids.add(b.get('id'))
                if not report: texts.append(message)
            if b.get('name')=='Bash': cmds.append(b.get('input',{}).get('command','')); cmd_ids.append(b.get('id'))
            elif b.get('name') in ('Write','Edit','NotebookEdit'): edits.append(b.get('input',{}).get('file_path',''))
            else:
                ran.add(lens_ran(b)); tools.append((b.get('name',''),b.get('id')))
                if lens_ran(b)=='browser-verifier': verifier_calls.append(b.get('id'))
                if lens_ran(b)=='implementer' and harness_plan.search(b.get('input',{}).get('prompt','')): harness_build=True
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
code=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
# A redirect counts by its target only: `node --test x.test.js > out.txt` names code but writes none.
redirect_target=re.compile(r'(?:>>?|\btee(?:\s+-a)?)\s*([^\s;&|]+)')
inplace_write=re.compile(r'sed -i|write_text')
def writes_code(c): return any(code.search(t) for t in redirect_target.findall(c)) or bool(inplace_write.search(c) and code.search(c))
if report and '/scratchpad/' not in final:
    problems.append("REPORT WITHOUT RAW OUTPUT: a REPORT names the scratchpad file holding the last 20 lines of each check (peer-sessions.md); run the checks in this thread and cite it.")
if not (built or any(code.search(e) for e in edits) or any(writes_code(c) for c in cmds)):
    if problems:
        print('\n'.join(problems),file=sys.stderr)
        sys.exit(2)
    sys.exit(0)
all_lines=[l for l in '\n'.join(texts).split('\n') if l.strip()]
verdicts={m.group(1) for l in all_lines if (m:=verdict.match(l))}
skipped={m.group(1) for l in all_lines if (m:=verdict.match(l)) and m.group(2)}
lines=[l for l in final.split('\n') if l.strip() and not verdict.match(l)]
first=lines[0] if lines else ''
last=lines[-1] if lines else ''
claim=None if first.rstrip().endswith('?') else re.search(r'(?<!not )(?<!fix )(?<!review )(?<!sweep )\b(done|fixed|works|passes|passing|green|ready to (ship|commit|merge))\b',first,re.I)
claim_word=claim.group(0) if claim else 'REPORT' if report else None
commit_ask=re.search(r'\bcommit(?!ted)',last,re.I) and re.search(r'\?|\bsay\b|approv|go ahead|want me',last,re.I)
committed=any(re.search(r'\bgit(?:\s+(?:-[Cc]\s+\S+|--?\w[\w-]*(?:=\S+)?))*\s+commit\b',c) for c in cmds)
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
evidence_ids=[i for i,c in zip(cmd_ids,cmds) if evidence.search(c) or (report and static_check.search(c))]
report_tail='; for a REPORT, the lens lines go in the message itself' if report else ''
no_evidence_close="run the step's → verify lines in this thread and cite their output" if report else 'or reword the first line as a status, not a claim'
no_check='no check ran since the last REPORT' if report else 'no test or runtime command ran this turn — static-clean (lint + tsc) is not done'
failed_run_close='; a REPORT cannot be reworded' if report else ', or reword the first line as a status that names what is still red'
if claim_word and not browser_run and not evidence_ids:
    problems.append("DONE-CLAIM WITHOUT EVIDENCE: the first line claims "+repr(claim_word)+" but "+no_check+". Exercise the change (tests, Playwright, curl, browser) and report the output, "+no_evidence_close+report_tail+".")
elif claim_word and evidence_ids and failed(results.get(evidence_ids[-1])):
    problems.append("DONE-CLAIM OVER A FAILED RUN: the first line claims "+repr(claim_word)+" but the last test or runtime command this turn failed (non-zero exit or a runner fail marker in its output). Fix the failures and rerun until green"+failed_run_close+report_tail+".")
web=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte)\b')
cwd=inp.get('cwd') or ''
def in_harness(cwd): return cwd==harness.rstrip('/') or cwd.startswith(harness) or harness_build
if (claim_word or commit_ask or committed) and ((built and not in_harness(cwd)) or any(web.search(e) and not e.startswith(harness) for e in edits)) and not any(static_check.search(c) for c in cmds):
    problems.append(f"LINT/TSC NOT RUN: this turn edited web code and {why}, and no lint or type-check command ran. Run them and report the output (CLAUDE.md: run linter + type checker).")
if claim_word or commit_ask or committed:
    verb,lenses='review','reuse-analyzer,placement-analyzer'
    if cwd and os.path.isdir(cwd):
        # Under the 10s Stop-hook timeout in settings.json; a killed hook blocks nothing.
        try: joins=subprocess.run(['bash',os.path.expanduser('~/.claude/hooks/review-classify.sh')],input=json.dumps(inp),cwd=cwd,capture_output=True,text=True,timeout=6).stdout
        except subprocess.TimeoutExpired: joins=''
        m=re.search(r'verb=(\S+) lenses=(\S+)',joins)
        if m: verb,lenses=m.groups()
    missing=[l for l in lenses.split(',') if l not in ran and l not in (skipped if built else verdicts)]
    hand_pass='; in a plan build a hand pass does not count: dispatch the lens or decline it with a reason' if built else ''
    if missing: problems.append(f"REVIEW NOT RUN for {', '.join(missing)}: this turn edited code and {why}, and the `{verb}` pass names those lenses. Per lens, run it (skill/agent) or hand-pass it and write `<lens>: N findings`, or decline with `<lens>: skip — <reason>` (~/.claude/review-routing.md){hand_pass}{report_tail}.")
if problems:
    print('\n'.join(problems),file=sys.stderr)
    sys.exit(2)
PY
