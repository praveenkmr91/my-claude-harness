#!/bin/bash
# Stop hook: first-line only, so "not done yet" in the body never trips it; stop_hook_active guards the retry.

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re
inp=json.loads(sys.argv[1])
if inp.get('stop_hook_active'): sys.exit(0)
path=inp.get('transcript_path')
if not path: sys.exit(0)
texts=[]; cmds=[]
for line in open(path):
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        if txt.strip() and not txt.lstrip().startswith('<'):
            texts=[]; cmds=[]
    elif t=='assistant':
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text': texts.append(b['text'])
            elif b.get('type')=='tool_use' and b.get('name')=='Bash': cmds.append(b.get('input',{}).get('command',''))
first=next((l for l in '\n'.join(texts).split('\n') if l.strip()),'')
if first.rstrip().endswith('?'): sys.exit(0)
claim=re.search(r'(?<!not )\b(done|fixed|works|passes|passing|green|ready to (ship|commit|merge))\b',first,re.I)
if not claim: sys.exit(0)
evidence=re.compile(r'\b(pnpm|npm|yarn|bun)\s+(run\s+)?(verify|test|e2e)|vitest|playwright|node --test|curl\s|http://localhost',re.I)
if any(evidence.search(c) for c in cmds): sys.exit(0)
print("DONE-CLAIM WITHOUT EVIDENCE: the first line claims "+repr(claim.group(0))+" but no test or runtime command ran this turn — static-clean (lint + tsc) is not done. Exercise the change (tests, Playwright, curl, browser) and report the output, or reword the first line as a status, not a claim.",file=sys.stderr)
sys.exit(2)
PY
