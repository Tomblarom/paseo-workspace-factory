import json,sys,glob,datetime as dt
def ts(s): return dt.datetime.fromisoformat(s.replace('Z','+00:00'))
comp=[];gaps=[]
for f in glob.glob('/home/code/.codex/sessions/2026/1[01]/**/*.jsonl',recursive=True):
    last=None;lastt=None;pending=None
    for line in open(f,errors='ignore'):
        try:e=json.loads(line)
        except:continue
        t=e.get('timestamp');p=e.get('payload',{}) or {}
        typ=e.get('type');pt=p.get('type')
        if typ=='compacted' or pt=='context_compacted':
            comp.append((last, 'manual' if pending else 'auto?'))
        if typ=='event_msg' and pt=='user_message':
            pending = (p.get('message') or '').strip().startswith('/compact')
        if typ=='event_msg' and pt=='token_count' and p.get('info'):
            u=p['info']['last_token_usage'];now=ts(t)
            if lastt and u['input_tokens']>20000:
                gap=(now-lastt).total_seconds()/60
                gaps.append((gap,u['input_tokens'],u.get('cached_input_tokens',0)))
            last=u['input_tokens'];lastt=now
print('compactions',len(comp))
for c in sorted(comp,key=lambda x:x[0] or 0)[:35]: print(' before',c)
import collections
b=collections.defaultdict(lambda:[0,0,0])
for g,i,c in gaps:
    k='<5' if g<5 else '5-30' if g<30 else '30-60' if g<60 else '60-180' if g<180 else '180-360' if g<360 else '360-720' if g<720 else '>720'
    b[k][0]+=1;b[k][1]+=i;b[k][2]+=c
for k in ['<5','5-30','30-60','60-180','180-360','360-720','>720']:
    n,i,c=b[k]
    if n: print(f'gap {k:>7} min: n={n:5} cached={c/i*100:5.1f}%')
