import type { AccountConfig, ClaudexConfig } from '../types.js';
import { DEFAULT_DEFAULTS } from './schema.js';

/**
 * Config-file-free mode.
 *
 * `CLAUDE_TOKEN_1`, `CLAUDE_TOKEN_2`, ... become accounts in numeric order.
 * Names and priorities can be overridden per index:
 *
 *   CLAUDE_TOKEN_1=sk-ant-oat01-...
 *   CLAUDEX_ACCOUNT_1_NAME=Personal
 *   CLAUDEX_ACCOUNT_1_PRIORITY=1
 *
 * This is the shape CI systems and secret managers hand you, so it is a
 * first-class path rather than a fallback of last resort.
 */
export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): ClaudexConfig | null {
  const indices = new Set<number>();
  for (const key of Object.keys(env)) {
    const match = /^CLAUDE_TOKEN_(\d+)$/.exec(key);
    if (match && env[key]?.trim()) indices.add(Number.parseInt(match[1] as string, 10));
  }
  if (indices.size === 0) return null;

  const warnings: string[] = [];
  const accounts: AccountConfig[] = [];

  for (const index of [...indices].sort((a, b) => a - b)) {
    const name = env[`CLAUDEX_ACCOUNT_${index}_NAME`]?.trim() || `Account ${index}`;
    const priorityRaw = env[`CLAUDEX_ACCOUNT_${index}_PRIORITY`]?.trim();
    let priority = index;
    if (priorityRaw !== undefined) {
      const parsed = Number.parseInt(priorityRaw, 10);
      if (Number.isNaN(parsed)) {
        warnings.push(`CLAUDEX_ACCOUNT_${index}_PRIORITY is not a number, using ${index}`);
      } else {
        priority = parsed;
      }
    }
    accounts.push({ name, provider: 'oauth', priority, token: `env:CLAUDE_TOKEN_${index}` });
  }

  const defaults = { ...DEFAULT_DEFAULTS, rotateOn: [...DEFAULT_DEFAULTS.rotateOn] };
  const maxSwitches = env['CLAUDEX_MAX_SWITCHES']?.trim();
  if (maxSwitches) {
    const parsed = Number.parseInt(maxSwitches, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) defaults.maxSwitches = parsed;
  }
  const claudePath = env['CLAUDEX_CLAUDE_BIN']?.trim();
  if (claudePath) defaults.claudePath = claudePath;

  return {
    version: 1,
    defaults,
    accounts,
    source: 'environment (CLAUDE_TOKEN_*)',
    warnings,
  };
}
