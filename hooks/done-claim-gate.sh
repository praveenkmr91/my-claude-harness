#!/bin/bash
# Stop hook: claim = first line only, so "not done yet" in the body never trips it; commit ask = last line. stop_hook_active guards the retry.
# Fires only on turns that edited a code file — answers, commits and doc edits carry no runtime claim.

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re,subprocess,os
inp=json.loads(sys.argv[1])
if inp.get('stop_hook_active'): sys.exit(0)
path=inp.get('transcript_path')
if not path: sys.exit(0)
REVIEW_SKILLS={'adversarial-reviewer','security-review','delete-list','simplify','shortcut-debt','react-best-practices','impeccable','code-review','review-pr'}
REVIEW_AGENTS={'reuse-analyzer','placement-analyzer','modern-ts-analyzer'}
lens_read=re.compile(r'/\.claude/agents/(reuse|placement)-analyzer\.md$')
def is_review(b):
    i=b.get('input',{})
    if b.get('name')=='Skill': return i.get('skill','').split(':')[-1] in REVIEW_SKILLS
    if b.get('name') in ('Agent','Task'):
        a=i.get('subagent_type','')
        return a in REVIEW_AGENTS or a.startswith('pr-review-toolkit:')
    return b.get('name')=='Read' and bool(lens_read.search(i.get('file_path','')))
# shortcut: turn-scoped — edits in one turn and the commit ask in a later turn escape the review check; upgrade = scope to edits since the last commit.
texts=[]; cmds=[]; edits=[]; reviewed=False
for line in open(path):
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        if txt.strip() and not txt.lstrip().startswith('<'):
            texts=[]; cmds=[]; edits=[]; reviewed=False
    elif t=='assistant':
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text': texts.append(b['text'])
            if b.get('type')!='tool_use': continue
            if b.get('name')=='Bash': cmds.append(b.get('input',{}).get('command',''))
            elif b.get('name') in ('Write','Edit','NotebookEdit'): edits.append(b.get('input',{}).get('file_path',''))
            elif is_review(b): reviewed=True
code=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
bash_write=re.compile(r'sed -i|write_text|\btee\b|>\s*\S+\.\w+')
if not (any(code.search(e) for e in edits) or any(bash_write.search(c) and code.search(c) for c in cmds)): sys.exit(0)
lines=[l for l in '\n'.join(texts).split('\n') if l.strip()]
first=lines[0] if lines else ''
last=lines[-1] if lines else ''
claim=None if first.rstrip().endswith('?') else re.search(r'(?<!not )(?<!fix )(?<!review )(?<!sweep )\b(done|fixed|works|passes|passing|green|ready to (ship|commit|merge))\b',first,re.I)
commit_ask=re.search(r'\bcommit(?!ted)',last,re.I) and re.search(r'\?|\bsay\b|approv|go ahead|want me',last,re.I)
problems=[]
evidence=re.compile(r'\b(pnpm|npm|yarn|bun)\s+(run\s+)?(verify|test|e2e)|vitest|playwright|node --test|curl\s|http://localhost',re.I)
if claim and not any(evidence.search(c) for c in cmds):
    problems.append("DONE-CLAIM WITHOUT EVIDENCE: the first line claims "+repr(claim.group(0))+" but no test or runtime command ran this turn — static-clean (lint + tsc) is not done. Exercise the change (tests, Playwright, curl, browser) and report the output, or reword the first line as a status, not a claim.")
if (claim or commit_ask) and not reviewed:
    verb,lenses='review','reuse-analyzer,placement-analyzer'
    cwd=inp.get('cwd')
    if cwd and os.path.isdir(cwd):
        # Under the 10s Stop-hook timeout in settings.json; a killed hook blocks nothing.
        try: joins=subprocess.run(['bash',os.path.expanduser('~/.claude/hooks/review-classify.sh')],input=json.dumps(inp),cwd=cwd,capture_output=True,text=True,timeout=6).stdout
        except subprocess.TimeoutExpired: joins=''
        m=re.search(r'verb=(\S+) lenses=(\S+)',joins)
        if m: verb,lenses=m.groups()
    problems.append(f"REVIEW NOT RUN: this turn edited code and {'claims done' if claim else 'asks to commit'} with no review pass. Run the `{verb}` pass (lenses: {lenses}) per ~/.claude/review-routing.md, fix what it confirms, then report — or, if the change is trivial, say so in one line (lint + tsc covers it).")
if problems:
    print('\n'.join(problems),file=sys.stderr)
    sys.exit(2)
PY
