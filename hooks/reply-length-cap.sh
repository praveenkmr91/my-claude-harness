#!/bin/bash
# Stop hook: blocks a final reply over the word cap once per turn (stop_hook_active guards the retry).
# Tiers come from what the hook can observe (prompt shape, turn effort), never from a marker the model writes.

INPUT=$(cat)
python3 - "$INPUT" <<'PY'
import json,sys,re
inp=json.loads(sys.argv[1])
if inp.get('stop_hook_active'): sys.exit(0)
path=inp.get('transcript_path')
if not path: sys.exit(0)
tail=[]; last_human=''; tool_calls=0; edited=set(); agents=0
for line in open(path):
    try: r=json.loads(line)
    except: continue
    t=r.get('type')
    if t=='user':
        tail=[]
        c=r.get('message',{}).get('content')
        txt=c if isinstance(c,str) else ' '.join(b.get('text','') for b in c if isinstance(b,dict) and b.get('type')=='text')
        if txt.strip() and not txt.lstrip().startswith('<'):
            last_human=txt; tool_calls=0; edited=set(); agents=0
    elif t=='assistant':
        for b in r.get('message',{}).get('content') or []:
            if not isinstance(b,dict): continue
            if b.get('type')=='text': tail.append(b['text'])
            elif b.get('type')=='tool_use':
                tool_calls+=1
                n=b.get('name','')
                if n in ('Edit','Write','NotebookEdit'): edited.add(b.get('input',{}).get('file_path'))
                if n=='Agent': agents+=1
text='\n'.join(tail)
text=re.sub(r'```.*?```','',text,flags=re.S)
text='\n'.join(l for l in text.split('\n') if not l.lstrip().startswith('|'))
words=len(text.split())
nocap=bool(re.search(r'\b(no cap|uncapped|full length|don.?t trim|no trimming)\b',last_human,re.I))
depth=bool(re.search(r'\b(depth|detail(ed|s)?|elaborate|explain|long(er)?|full|essay|verbose)\b',last_human,re.I))
listy=bool(re.search(r'\b(bullet|bullets|bullet points|consolidat(e|ed)|all of it|everything|list (them|it) (all|out))\b',last_human,re.I))
verb=bool(re.search(r'\b(review|battery|harden|trim|audit|verify)\b|\b(should we|why|correct me|am i wrong|u r wrong|you are wrong)\b[^?]*\?',last_human,re.I))
heavy=tool_calls>=8 or len(edited)>=3 or agents>=2
if nocap: sys.exit(0)
if depth and heavy: cap=450; tier='depth ask + heavy turn'
elif depth or verb or heavy or listy: cap=300; tier='depth ask' if depth else ('review/debate verb' if verb else 'list-shaped ask' if listy and not heavy else f'heavy turn ({tool_calls} tool calls, {len(edited)} files, {agents} agents)')
else: cap=180; tier='default'
if words>cap:
    print(f"REPLY TOO LONG: {words} words, cap {cap} [{tier}] (tables and code blocks excluded). Rewrite in <= {cap} words without dropping any fact: verdict first, one line per point, evidence and lists into a table (uncounted), anything longer into a file the reply names. Cut connective prose, not content.",file=sys.stderr)
    sys.exit(2)
PY
