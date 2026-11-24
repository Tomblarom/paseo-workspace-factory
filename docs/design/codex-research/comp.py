import json,glob
rows=[]
for f in glob.glob('/home/code/.codex/sessions/2026/1[01]/**/*.jsonl',recursive=True):
    ev=[]
    for line in open(f,errors='ignore'):
        try:e=json.loads(line)
        except:continue
        p=e.get('payload') or {}
        if e.get('type')=='compacted': ev.append(('C',e['timestamp'],len(json.dumps(p))))
        elif e.get('type')=='event_msg' and p.get('type')=='token_count' and p.get('info'):
            u=p['info']['last_token_usage'];t=p['info']['total_token_usage']
            ev.append(('T',e['timestamp'],u['input_tokens'],u.get('cached_input_tokens',0),u.get('output_tokens',0),t['input_tokens'],t.get('cached_input_tokens',0)))
    for i,x in enumerate(ev):
        if x[0]!='C':continue
        before=[y for y in ev[:i] if y[0]=='T'][-2:]
        after=[y for y in ev[i+1:] if y[0]=='T'][:2]
        rows.append((f[-50:-6],x[2],before,after))
for r in rows[:14]:
    b=r[2];a=r[3]
    fmt=lambda y:f"in={y[2]} cached={y[3]} out={y[4]}"
    print(r[0][-12:],'compactedPayloadChars',r[1],'| before:',' ; '.join(fmt(y) for y in b),'| after:',' ; '.join(fmt(y) for y in a))
print(len(rows))
