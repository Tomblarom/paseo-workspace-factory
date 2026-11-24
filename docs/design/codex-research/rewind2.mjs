import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { daemonPassword, paseoBinary } from '/home/code/projects/paseo-workspace-factory/src/paseo.mjs';
import { runtime } from '/home/code/projects/paseo-workspace-factory/src/runtime.mjs';
const [id, msgId] = process.argv.slice(2);
const req = createRequire(realpathSync(paseoBinary()));
const { DaemonClient } = await import(pathToFileURL(req.resolve('@getpaseo/client').replace(/index\.js$/, 'daemon-client.js')).href);
const d = new DaemonClient({ url: runtime().paseo.url, password: daemonPassword(), clientId: 'wsf-rewind-test', clientType: 'cli', logger: { debug(){}, info(){}, warn(){}, error(){}, child(){ return this; } }, reconnect: { enabled: false } });
await d.connect();
if (!msgId) { const tl = await d.fetchAgentTimeline(id, { limit: 0, projection: 'canonical' }); for (const r of tl.entries) { const i = r.item; console.log(i.type, i.messageId ?? i.callId ?? ''); } }
else { try { console.log(await d.rewindAgent(id, msgId, 'conversation')); } catch (e) { console.log('ERR', e.message); } }
await d.close(); process.exit(0);
