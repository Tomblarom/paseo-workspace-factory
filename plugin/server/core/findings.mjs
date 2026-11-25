import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FACTORY_PLUGIN_ID = 'workspace-factory';
export const PROMPT_SETTINGS_RPC = 'factory.prompt-settings';

export function findFactoryCheckout(directory) {
  if (!existsSync(join(directory, '.git'))) return null;
  if (existsSync(join(directory, 'FINDINGS.md'))) return directory;
  try {
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    return pkg.name === 'paseo-workspace-factory' ? directory : null;
  } catch {
    return null;
  }
}

export function findingsPassage({ factoryRoot = null, findingsInPrompts = true } = {}) {
  // Only a git-checkout install has a FINDINGS.md the agent can write to.
  if (findingsInPrompts === false || !factoryRoot) return '';
  const destination = `\`${join(factoryRoot, 'FINDINGS.md')}\``;
  return [
    `Record Workspace Factory friction, wasted or expensive cached context, quota waste, unclear briefs, or bugs in ${destination}.`,
    'Add a short entry in this format `- YYYY-MM-DD · <role/slot> · <observation> · <evidence or suggestion>`.',
    'Propose moving an entry to TODO.md only when needed, and move it only with the user’s consent. Mark moved entries with `→ TODO`.',
  ].join('\n');
}
