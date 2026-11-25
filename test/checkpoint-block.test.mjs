// Fenced CHECKPOINT standard: every factory-generated text carries the
// checkpoint as a triple-backtick code block, and the parser reads the fenced
// form as well as the bare legacy form. Fakes only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildAssignment } from '../src/assign.mjs';
import {
  buildHandoff, CHECKPOINT_KEY, checkpointRules, formatCheckpointBlock, parseCheckpointBlock, switchSteer,
} from '../src/steer.mjs';
import { LABEL, METADATA_KEY } from '../src/paseo.mjs';

const REPO = 'example-owner/example-repo';
const FENCE = '```text\nCHECKPOINT\ntask: ';

// ------------------------------------------------------------------- parser

test('parseCheckpointBlock reads the bare legacy form', () => {
  assert.deepEqual(
    parseCheckpointBlock('Ergebnis.\n\nCHECKPOINT\ntask: Ship it\ntests: keine\nblockers: none\nnext: confirm\n'),
    { task: 'Ship it', tests: [], blockers: [], next: 'confirm' },
  );
});

test('parseCheckpointBlock reads the fenced form with dashes', () => {
  for (const fence of ['```', '```text']) {
    assert.deepEqual(
      parseCheckpointBlock(`Ergebnis.\n\n${fence}\nCHECKPOINT\n- task: Ship it\n- tests: npm test\n- blockers: none\n- next: confirm\n${'```'}\n`),
      { task: 'Ship it', tests: ['npm test'], blockers: [], next: 'confirm' },
    );
  }
});

test('parseCheckpointBlock tolerates an informational workers line', () => {
  const withWorkers = '```text\nCHECKPOINT\n- task: Ship it\n- tests: none\n- blockers: none\n- workers: agent-1, agent-2\n- next: confirm\n```';
  assert.deepEqual(parseCheckpointBlock(withWorkers), { task: 'Ship it', tests: [], blockers: [], next: 'confirm' });
  const trailing = 'CHECKPOINT\ntask: Ship it\nworkers: agent-1\nnext: confirm';
  assert.deepEqual(parseCheckpointBlock(trailing), { task: 'Ship it', tests: [], blockers: [], next: 'confirm' });
});

test('parseCheckpointBlock still takes the last block and requires a task', () => {
  assert.equal(parseCheckpointBlock('```text\nCHECKPOINT\n- task: old\n```\ntext\n```text\nCHECKPOINT\n- task: new\n```').task, 'new');
  assert.equal(parseCheckpointBlock('no block here'), null);
  assert.equal(parseCheckpointBlock('```text\nCHECKPOINT\n- tests: x\n```'), null);
});

test('parseCheckpointBlock reads the optional status line and stays compatible', () => {
  for (const status of ['done', 'partial', 'blocked']) {
    assert.equal(
      parseCheckpointBlock(`\`\`\`text\nCHECKPOINT\n- task: Ship it\n- status: ${status}\n\`\`\``).status,
      status,
    );
    assert.equal(
      parseCheckpointBlock(`CHECKPOINT\ntask: Ship it\nstatus: ${status.toUpperCase()}\n`).status,
      status,
    );
  }
  assert.equal(parseCheckpointBlock('```text\nCHECKPOINT\n- task: Ship it\n- status: finished\n```').status, undefined);
  assert.equal(parseCheckpointBlock('```text\nCHECKPOINT\n- task: Ship it\n```').status, undefined);
  assert.deepEqual(
    parseCheckpointBlock('```text\nCHECKPOINT\n- task: Ship it\n- tests: none\n- blockers: none\n- next: confirm\n```'),
    { task: 'Ship it', tests: [], blockers: [], next: 'confirm' },
  );
});

// ------------------------------------------------------------------ builders

test('formatCheckpointBlock renders the fixed fenced form', () => {
  assert.equal(
    formatCheckpointBlock({ task: 'Ship it', tests: ['npm test'], blockers: [], next: null }),
    '```text\nCHECKPOINT\ntask: Ship it\ntests: npm test\nblockers: none\nnext: none\n```',
  );
  assert.equal(
    formatCheckpointBlock({ task: 'a\nb', tests: [], blockers: ['x\ny'], next: '' }).split('\n').length,
    7,
    'values stay single-line so the block parses back',
  );
});

test('checkpoint rules teach the same fenced format as the generated handoff', () => {
  const rules = checkpointRules();
  assert.ok(rules.includes(FENCE));
  assert.match(rules, /^status: done \| partial \| blocked$/m);
  assert.doesNotMatch(rules, /^- (task|tests|blockers|next|status):/m);
});

function handoffStatus(checkpoint) {
  return {
    repo: REPO,
    workspace: { id: 'wks_0001', directory: '/p/demo' },
    checkpoint,
    workers: [],
  };
}

const HANDOFF_ARGS = {
  from: { slot: 'A', id: 'agent-a' },
  to: { slot: 'B', id: 'agent-b' },
  epoch: 3,
  git: null,
};

test('buildHandoff carries the fenced block in English and German', () => {
  const checkpoint = {
    task: 'Ship it', tests: ['npm test'], blockers: ['flaky'], next: 'confirm',
    epoch: 3, updatedAt: '2026-11-23T12:00:00.000Z',
  };
  for (const language of ['en', 'de']) {
    const packet = buildHandoff(handoffStatus(checkpoint), { ...HANDOFF_ARGS, language });
    assert.ok(packet.includes(FENCE), `${language} handoff carries the fenced block`);
    assert.deepEqual(parseCheckpointBlock(packet), {
      task: 'Ship it', tests: ['npm test'], blockers: ['flaky'], next: 'confirm',
    });
  }
});

test('buildHandoff without a task carries no block to check in', () => {
  const packet = buildHandoff(handoffStatus(null), HANDOFF_ARGS);
  assert.match(packet, /NONE RECORDED/);
  assert.ok(!packet.includes('\nCHECKPOINT\n'), 'no block without a task');
});

test('buildAssignment carries the fenced block and parses back', () => {
  const packet = buildAssignment({ repo: REPO }, {
    slot: 'A', steerId: 'agent-a', epoch: 3,
    task: 'Ship it', tests: [], blockers: [], next: null,
  });
  assert.ok(packet.includes(FENCE), 'assignment carries the fenced block');
  assert.deepEqual(parseCheckpointBlock(packet), { task: 'Ship it', tests: [], blockers: [], next: null });
  assert.equal(packet, buildAssignment({ repo: REPO }, {
    slot: 'A', steerId: 'agent-a', epoch: 3,
    task: 'Ship it', tests: [], blockers: [], next: null,
  }), 'still deterministic');
});

// ------------------------------------------------------- delivery integration

function fakeWorld(checkpoint) {
  const ws = {
    id: 'wks_0001', projectId: 'prj_1', workspaceDirectory: '/p/demo', workspaceKind: 'local_checkout',
    title: 'Main', name: 'Main',
    metadata: { [METADATA_KEY]: { main: true, activeSteer: 'A', epoch: 3 }, ...(checkpoint ? { [CHECKPOINT_KEY]: checkpoint } : {}) },
    createdAt: '2026-11-23T12:00:00.000Z',
  };
  const agents = ['A', 'B'].map((slot, i) => ({
    id: `agent-${i}`, status: 'idle', archivedAt: null, title: `Steer ${slot}`, workspaceId: ws.id,
    provider: 'codex', model: 'm', labels: { [LABEL.repo]: REPO, [LABEL.role]: 'steer', [LABEL.slot]: slot },
  }));
  return { ws, agents };
}

test('switch delivery carries the fenced block to the new steer', async () => {
  const { ws, agents } = fakeWorld({ task: 'Ship it', tests: [], blockers: [], next: 'confirm', epoch: 3 });
  const client = {
    workspaces: { ref: () => ({ refresh: async () => structuredClone(ws), setMetadata: async () => {} }) },
    agents: {
      ref: () => ({ timeline: { refetch: async () => ({ entries: [] }) } }),
    },
  };
  const discovery = {
    forkName: REPO, mainWorkspace: structuredClone(ws),
    steers: { labelled: structuredClone(agents), legacy: [] }, workers: [], providers: [],
  };
  const git = (cwd, args) => {
    if (args[0] === 'rev-parse') return 'main';
    if (args[0] === 'status') return '';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  const result = await switchSteer({ client, discovery, toSlot: 'B', git, lock: (_n, fn) => fn({ verify() {} }) });
  assert.ok(result.packet.includes(FENCE), 'switch packet carries the fenced block');
  assert.equal(parseCheckpointBlock(result.packet).task, 'Ship it');
});

// --------------------------------------------------------------------- docs

const readDoc = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

test('instruction docs require and show the fenced block', () => {
  const instructions = readDoc('docs/steer-instructions.md');
  assert.ok(instructions.includes(FENCE), 'answer template shows the fenced block');
  assert.ok(instructions.includes('\nblockers: <open problems, or "none">'), 'field lines shown directly');
  const required = instructions.match(/fenced CHECKPOINT block/g) ?? [];
  assert.ok(required.length >= 3, `steer, worker and answer-format sections require it (${required.length})`);
  assert.match(readDoc('AGENTS.md'), /fenced CHECKPOINT block/, 'repo instructions require it');
});

test('instruction docs document the status line and worker completion', () => {
  const instructions = readDoc('docs/steer-instructions.md');
  assert.ok(instructions.includes('`status: done|partial|blocked`'), 'optional status line documented');
  assert.match(instructions, /worker without a CHECKPOINT block/i, 'unfinished without CHECKPOINT');
  assert.match(instructions, /interrupted/, 'interrupted counts as unfinished');
  assert.match(instructions, /resume <scope> --agent <worker-id> --apply/, 'resume uses Factory delivery');
  assert.match(instructions, /resume brief/i, 'resume brief is carried');
  assert.match(instructions, /verify .* against the assignment/i, 'result checked against the task');
});
