#!/bin/bash
# Stop hook: claim = first line only, so "not done yet" in the body never trips it; commit ask = last line; per-lens verdict lines are excluded from both.
# One-shot: stop_hook_active passes the retry unchecked, so the block message must carry the exact verdict format.
# Claim and lens checks fire only on turns that edited a code file — answers, commits and doc edits carry no runtime claim. A review verb named in the prompt is checked on every turn.

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re,subprocess,os
inp=json.loads(sys.argv[1])
if inp.get('stop_hook_active'): sys.exit(0)
path=inp.get('transcript_path')
if not path: sys.exit(0)
verdict=re.compile(r'^\s*(?:[-*]\s+)?[`*]*([a-z][a-z-]+)[`*]*:\s*(?:\d+ findings?\b.*|skip\s*[—–-]\s*\S.*)$')
def lens_ran(b):
    i=b.get('input',{})
    if b.get('name')=='Skill': return i.get('skill','').split(':')[-1]
    if b.get('name') in ('Agent','Task'): return i.get('subagent_type','').split(':')[-1]
# shortcut: turn-scoped — edits in one turn and the commit ask in a later turn escape the review check; upgrade = scope to edits since the last commit.
texts=[]; cmds=[]; edits=[]; ran=set(); tools=[]; prompt=''
for line in open(path):
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        # isMeta = skill bodies, peer hand-backs and this hook's own feedback — not a new prompt, or they reset `ran` and re-trip on the verbs they quote.
        if txt.strip() and not txt.lstrip().startswith('<') and not r.get('isMeta'):
            texts=[]; cmds=[]; edits=[]; ran=set(); tools=[]; prompt=txt
    elif t=='assistant':
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text': texts.append(b['text'])
            if b.get('type')!='tool_use': continue
            if b.get('name')=='Bash': cmds.append(b.get('input',{}).get('command',''))
            elif b.get('name') in ('Write','Edit','NotebookEdit'): edits.append(b.get('input',{}).get('file_path',''))
            else: ran.add(lens_ran(b)); tools.append(b.get('name',''))
problems=[]
# Mirrors the verb table in review-routing.md and review-battery.md — a member renamed there must be renamed here. Triggers omit the aliases `simplify` and `break it` on purpose: they collide with build asks.
NAMED_VERBS={
    'battery':(r'\b(battery|full review|deep review|thorough review)\b',['code-reviewer','silent-failure-hunter','type-design-analyzer','reuse-analyzer','placement-analyzer','comment-analyzer','modern-ts-analyzer']),
    'harden':(r'\b(harden|security review|bug hunt|adversarial)\b',['adversarial-reviewer','security-review']),
    'trim':(r'\b(trim|de-vibe)\b(?!-\d)',['delete-list','simplify','comment-analyzer','modern-ts-analyzer','shortcut-debt']),
}
if not prompt.rstrip().endswith('?'):
    for verb,(pattern,members) in NAMED_VERBS.items():
        if not re.search(pattern,prompt,re.I): continue
        missing=[m for m in members if m not in ran]
        if missing: problems.append(f"NAMED VERB NOT RUN: the prompt asks for `{verb}`, and no Skill/Agent call ran for {', '.join(missing)}. A verdict line does not count here — invoke each member, or say which you are not running and why.")
code=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
bash_write=re.compile(r'sed -i|write_text|\btee\b|>\s*\S+\.\w+')
if not (any(code.search(e) for e in edits) or any(bash_write.search(c) and code.search(c) for c in cmds)):
    if problems:
        print('\n'.join(problems),file=sys.stderr)
        sys.exit(2)
    sys.exit(0)
all_lines=[l for l in '\n'.join(texts).split('\n') if l.strip()]
verdicts={m.group(1) for l in all_lines if (m:=verdict.match(l))}
lines=[l for l in all_lines if not verdict.match(l)]
first=lines[0] if lines else ''
last=lines[-1] if lines else ''
claim=None if first.rstrip().endswith('?') else re.search(r'(?<!not )(?<!fix )(?<!review )(?<!sweep )\b(done|fixed|works|passes|passing|green|ready to (ship|commit|merge))\b',first,re.I)
commit_ask=re.search(r'\bcommit(?!ted)',last,re.I) and re.search(r'\?|\bsay\b|approv|go ahead|want me',last,re.I)
evidence=re.compile(r'\b(pnpm|npm|yarn|bun)\s+(run\s+)?(verify|test|e2e)|vitest|playwright|node --test|curl\s|http://localhost',re.I)
browser_run=any(n.startswith(('mcp__chrome-devtools__','mcp__playwright__')) for n in tools) or 'external-io' in ran
if claim and not browser_run and not any(evidence.search(c) for c in cmds):
    problems.append("DONE-CLAIM WITHOUT EVIDENCE: the first line claims "+repr(claim.group(0))+" but no test or runtime command ran this turn — static-clean (lint + tsc) is not done. Exercise the change (tests, Playwright, curl, browser) and report the output, or reword the first line as a status, not a claim.")
web=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte)\b')
harness=os.path.expanduser('~/.claude/')
static_check=re.compile(r'\b(eslint|tsc|vue-tsc|lint|typecheck|type-check|verify|check:types?)\b',re.I)
if (claim or commit_ask) and any(web.search(e) and not e.startswith(harness) for e in edits) and not any(static_check.search(c) for c in cmds):
    problems.append(f"LINT/TSC NOT RUN: this turn edited web code and {'claims done' if claim else 'asks to commit'}, and no lint or type-check command ran. Run them and report the output (CLAUDE.md: run linter + type checker).")
if claim or commit_ask:
    verb,lenses='review','reuse-analyzer,placement-analyzer'
    cwd=inp.get('cwd')
    if cwd and os.path.isdir(cwd):
        # Under the 10s Stop-hook timeout in settings.json; a killed hook blocks nothing.
        try: joins=subprocess.run(['bash',os.path.expanduser('~/.claude/hooks/review-classify.sh')],input=json.dumps(inp),cwd=cwd,capture_output=True,text=True,timeout=6).stdout
        except subprocess.TimeoutExpired: joins=''
        m=re.search(r'verb=(\S+) lenses=(\S+)',joins)
        if m: verb,lenses=m.groups()
    missing=[l for l in lenses.split(',') if l not in ran and l not in verdicts]
    if missing: problems.append(f"REVIEW NOT RUN for {', '.join(missing)}: this turn edited code and {'claims done' if claim else 'asks to commit'}, and the `{verb}` pass names those lenses. Per lens, run it (skill/agent) or hand-pass it and write `<lens>: N findings`, or decline with `<lens>: skip — <reason>` (~/.claude/review-routing.md).")
if problems:
    print('\n'.join(problems),file=sys.stderr)
    sys.exit(2)
PY
