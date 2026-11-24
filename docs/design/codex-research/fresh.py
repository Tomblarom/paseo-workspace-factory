import json,glob,statistics as st
first=[];t5=[];t10=[];chains=[]
for f in glob.glob('/home/code/.codex/sessions/2026/1[01]/**/*.jsonl',recursive=True):
    toks=[];comps=[];n=0
    for line in open(f,errors='ignore'):
        try:e=json.loads(line)
        except:continue
        p=e.get('payload') or {}
        if e.get('type')=='compacted': comps.append(len(toks))
        elif e.get('type')=='event_msg' and p.get('type')=='token_count' and p.get('info'):
            u=p['info']['last_token_usage']
            if u['input_tokens']>0: toks.append((u['input_tokens'],u.get('cached_input_tokens',0)))
    if not toks: continue
    first.append(toks[0])
    if len(toks)>=20: t5.append(toks[19][0])
    if len(toks)>=100: t10.append(toks[99][0])
    if len(comps)>=2:
        post=[toks[i][0] for i in comps if i<len(toks)]
        chains.append(post)
q=lambda xs:(len(xs),int(st.median(xs)),int(st.quantiles(xs,n=10)[0]),int(st.quantiles(xs,n=10)[-1])) if len(xs)>2 else xs
print('first request in/cached median:',int(st.median(x[0] for x in first)),int(st.median(x[1] for x in first)),'n',len(first))
print('ctx at request 20 (n,med,p10,p90):',q(t5))
print('ctx at request 100:',q(t10))
print('post-compact ctx per chain:',chains)
