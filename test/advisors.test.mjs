// Advisor policy config: validation of the optional `advisors.profiles`
// mapping (advisor purpose -> factory profile name). Policy only; the
// factory creates no advisor agents itself (native paseo-advisor skill).
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig } from '../src/config.mjs';

function baseConfig() {
  return {
    version: 1,
    github: { owner: 'example', cloneProtocol: 'https', upstreamRemote: 'upstream' },
    checkoutRoot: '/home/you/projects',
    workspaceTitle: 'Main',
    profiles: {
      strong: { provider: 'example', model: 'large', thinking: 'high', mode: null },
      cheap: { provider: 'example', model: 'small', thinking: null, mode: null },
    },
    steers: { slots: { A: 'cheap' }, prepare: ['A'], initialActive: 'A' },
  };
}

test('advisors is optional and defaults to native profile matching', () => {
  assert.deepEqual(validateConfig(baseConfig()), []);
  assert.deepEqual(validateConfig({ ...baseConfig(), advisors: {} }), []);
  assert.deepEqual(validateConfig({ ...baseConfig(), advisors: { profiles: {} } }), []);
});

test('advisors.profiles maps purposes to known profiles', () => {
  const config = baseConfig();
  config.advisors = { profiles: { design: 'strong', review: 'strong', routine: 'cheap' } };
  assert.deepEqual(validateConfig(config), []);
});

test('advisors.profiles rejects unknown profiles and bad shapes', () => {
  const unknown = baseConfig();
  unknown.advisors = { profiles: { design: 'missing' } };
  assert.deepEqual(validateConfig(unknown), ['advisors.profiles.design references unknown profile "missing"']);

  const notObject = baseConfig();
  notObject.advisors = { profiles: ['strong'] };
  assert.deepEqual(validateConfig(notObject), ['advisors.profiles must be an object']);

  const advisorsArray = baseConfig();
  advisorsArray.advisors = [];
  assert.deepEqual(validateConfig(advisorsArray), ['advisors must be an object']);

  const emptyPurpose = baseConfig();
  emptyPurpose.advisors = { profiles: { '': 'strong' } };
  assert.deepEqual(validateConfig(emptyPurpose), ['advisors.profiles has an empty purpose name']);
});
