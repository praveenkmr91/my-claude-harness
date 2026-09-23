#!/bin/bash
# Stop hook: first-line only, so "not done yet" in the body never trips it; stop_hook_active guards the retry.
# Fires only on turns that edited a code file — answers, commits and doc edits carry no runtime claim.

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re
inp=json.loads(sys.argv[1])
if inp.get('stop_hook_active'): sys.exit(0)
path=inp.get('transcript_path')
if not path: sys.exit(0)
texts=[]; cmds=[]; edits=[]
for line in open(path):
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        if txt.strip() and not txt.lstrip().startswith('<'):
            texts=[]; cmds=[]; edits=[]
    elif t=='assistant':
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text': texts.append(b['text'])
            elif b.get('type')=='tool_use' and b.get('name')=='Bash': cmds.append(b.get('input',{}).get('command',''))
            elif b.get('type')=='tool_use' and b.get('name') in ('Write','Edit','NotebookEdit'): edits.append(b.get('input',{}).get('file_path',''))
code=re.compile(r'\.(jsx?|tsx?|mjs|cjs|vue|svelte|css|scss|html|swift|kt|dart|sh|py)\b')
bash_write=re.compile(r'sed -i|write_text|\btee\b|>\s*\S+\.\w+')
if not (any(code.search(e) for e in edits) or any(bash_write.search(c) and code.search(c) for c in cmds)): sys.exit(0)
first=next((l for l in '\n'.join(texts).split('\n') if l.strip()),'')
if first.rstrip().endswith('?'): sys.exit(0)
claim=re.search(r'(?<!not )(?<!fix )(?<!review )(?<!sweep )\b(done|fixed|works|passes|passing|green|ready to (ship|commit|merge))\b',first,re.I)
if not claim: sys.exit(0)
evidence=re.compile(r'\b(pnpm|npm|yarn|bun)\s+(run\s+)?(verify|test|e2e)|vitest|playwright|node --test|curl\s|http://localhost',re.I)
if any(evidence.search(c) for c in cmds): sys.exit(0)
print("DONE-CLAIM WITHOUT EVIDENCE: the first line claims "+repr(claim.group(0))+" but no test or runtime command ran this turn — static-clean (lint + tsc) is not done. Exercise the change (tests, Playwright, curl, browser) and report the output, or reword the first line as a status, not a claim.",file=sys.stderr)
sys.exit(2)
PY
