import type { AccountConfig, ClaudexConfig, ConfigDefaults, FailureClass, ProviderKind } from '../types.js';
import type { YamlValue } from './mini-yaml.js';
import { expandTilde } from '../util/paths.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const PROVIDER_KINDS: ProviderKind[] = ['oauth', 'configdir', 'keychain'];

const ROTATABLE_CLASSES: FailureClass[] = [
  'usage_limit',
  'rate_limit',
  'overloaded',
  'auth_expired',
  'credit_exhausted',
];

export const DEFAULT_DEFAULTS: ConfigDefaults = {
  provider: 'oauth',
  maxSwitches: 3,
  rotateOn: ['usage_limit', 'rate_limit', 'overloaded', 'auth_expired', 'credit_exhausted'],
  quiet: false,
  sticky: false,
};

function isRecord(value: YamlValue): value is Record<string, YamlValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: YamlValue, field: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new ConfigError(`${field} must be a string`);
}

/** Expand `${VAR}` from the environment. Unresolved vars are reported, not thrown. */
export function expandVars(
  value: string,
  env: NodeJS.ProcessEnv,
  missing: string[],
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = env[name];
    if (resolved === undefined || resolved === '') {
      missing.push(name);
      return '';
    }
    return resolved;
  });
}

function parseDefaults(raw: YamlValue | undefined, warnings: string[]): ConfigDefaults {
  const defaults: ConfigDefaults = { ...DEFAULT_DEFAULTS, rotateOn: [...DEFAULT_DEFAULTS.rotateOn] };
  if (raw === undefined || raw === null) return defaults;
  if (!isRecord(raw)) throw new ConfigError('`defaults` must be a mapping');

  const provider = raw['provider'];
  if (provider !== undefined && provider !== null) {
    const kind = asString(provider, 'defaults.provider');
    if (!PROVIDER_KINDS.includes(kind as ProviderKind)) {
      throw new ConfigError(`defaults.provider must be one of ${PROVIDER_KINDS.join(', ')}`);
    }
    defaults.provider = kind as ProviderKind;
  }

  const maxSwitches = raw['max_switches'];
  if (maxSwitches !== undefined && maxSwitches !== null) {
    if (typeof maxSwitches !== 'number' || !Number.isInteger(maxSwitches) || maxSwitches < 0) {
      throw new ConfigError('defaults.max_switches must be a non-negative integer');
    }
    defaults.maxSwitches = maxSwitches;
  }

  const rotateOn = raw['rotate_on'];
  if (rotateOn !== undefined && rotateOn !== null) {
    if (!Array.isArray(rotateOn)) throw new ConfigError('defaults.rotate_on must be a list');
    const classes: FailureClass[] = [];
    for (const entry of rotateOn) {
      const name = asString(entry, 'defaults.rotate_on entry');
      if (!ROTATABLE_CLASSES.includes(name as FailureClass)) {
        warnings.push(
          `ignoring unknown rotate_on value "${name}" (known: ${ROTATABLE_CLASSES.join(', ')})`,
        );
        continue;
      }
      classes.push(name as FailureClass);
    }
    defaults.rotateOn = classes;
  }

  const quiet = raw['quiet'];
  if (quiet !== undefined && quiet !== null) {
    if (typeof quiet !== 'boolean') throw new ConfigError('defaults.quiet must be true or false');
    defaults.quiet = quiet;
  }

  const sticky = raw['sticky'];
  if (sticky !== undefined && sticky !== null) {
    if (typeof sticky !== 'boolean') throw new ConfigError('defaults.sticky must be true or false');
    defaults.sticky = sticky;
  }

  return defaults;
}

function parseAccount(
  raw: YamlValue,
  index: number,
  defaults: ConfigDefaults,
  env: NodeJS.ProcessEnv,
  warnings: string[],
): AccountConfig {
  if (!isRecord(raw)) throw new ConfigError(`accounts[${index}] must be a mapping`);

  const nameRaw = raw['name'];
  if (nameRaw === undefined || nameRaw === null || asString(nameRaw, 'name').trim() === '') {
    throw new ConfigError(`accounts[${index}] is missing a name`);
  }
  const name = asString(nameRaw, `accounts[${index}].name`).trim();

  const providerRaw = raw['provider'];
  const provider =
    providerRaw === undefined || providerRaw === null
      ? defaults.provider
      : (asString(providerRaw, `accounts[${index}].provider`) as ProviderKind);
  if (!PROVIDER_KINDS.includes(provider)) {
    throw new ConfigError(
      `account "${name}": provider must be one of ${PROVIDER_KINDS.join(', ')}`,
    );
  }

  const priorityRaw = raw['priority'];
  let priority = index + 1;
  if (priorityRaw !== undefined && priorityRaw !== null) {
    if (typeof priorityRaw !== 'number' || !Number.isFinite(priorityRaw)) {
      throw new ConfigError(`account "${name}": priority must be a number`);
    }
    priority = priorityRaw;
  }

  const account: AccountConfig = { name, provider, priority };

  const token = raw['token'];
  if (token !== undefined && token !== null) {
    account.token = asString(token, `account "${name}": token`);
  }

  const configDirRaw = raw['config_dir'];
  if (configDirRaw !== undefined && configDirRaw !== null) {
    const missing: string[] = [];
    const expanded = expandVars(asString(configDirRaw, `account "${name}": config_dir`), env, missing);
    if (missing.length > 0) {
      warnings.push(`account "${name}": config_dir references unset ${missing.join(', ')}`);
    }
    account.configDir = expandTilde(expanded);
  }

  const keychainService = raw['keychain_service'];
  if (keychainService !== undefined && keychainService !== null) {
    account.keychainService = asString(keychainService, `account "${name}": keychain_service`);
  }
  const keychainAccount = raw['keychain_account'];
  if (keychainAccount !== undefined && keychainAccount !== null) {
    account.keychainAccount = asString(keychainAccount, `account "${name}": keychain_account`);
  }

  // Per-provider requirements. These are hard errors: a misconfigured account
  // that silently never gets picked is worse than a startup failure.
  if (provider === 'configdir' && !account.configDir) {
    throw new ConfigError(`account "${name}": provider "configdir" requires config_dir`);
  }
  if (provider === 'keychain' && !account.keychainService) {
    account.keychainService = 'Claude Code-credentials';
  }
  if (provider === 'keychain' && !account.keychainAccount) {
    throw new ConfigError(
      `account "${name}": provider "keychain" requires keychain_account ` +
        `(the account name of the stored credentials item)`,
    );
  }
  if (provider === 'oauth' && !account.token) {
    account.token = `store:${name}`;
  }

  return account;
}

export function parseConfig(
  raw: YamlValue,
  source: string,
  env: NodeJS.ProcessEnv = process.env,
): ClaudexConfig {
  const warnings: string[] = [];
  if (!isRecord(raw)) throw new ConfigError(`${source}: top level must be a mapping`);

  const version = raw['version'];
  if (version !== undefined && version !== null && version !== 1) {
    warnings.push(`${source}: unknown config version ${String(version)}, parsing as version 1`);
  }

  const defaults = parseDefaults(raw['defaults'], warnings);

  const claudePath = raw['claude_path'];
  if (claudePath !== undefined && claudePath !== null) {
    const missing: string[] = [];
    defaults.claudePath = expandTilde(expandVars(asString(claudePath, 'claude_path'), env, missing));
    if (missing.length > 0) warnings.push(`claude_path references unset ${missing.join(', ')}`);
  }

  const accountsRaw = raw['accounts'];
  if (accountsRaw === undefined || accountsRaw === null) {
    throw new ConfigError(`${source}: no \`accounts\` list defined`);
  }
  if (!Array.isArray(accountsRaw)) throw new ConfigError(`${source}: \`accounts\` must be a list`);

  const accounts = accountsRaw.map((entry, index) =>
    parseAccount(entry, index, defaults, env, warnings),
  );

  const seen = new Set<string>();
  for (const account of accounts) {
    const key = account.name.toLowerCase();
    if (seen.has(key)) throw new ConfigError(`${source}: duplicate account name "${account.name}"`);
    seen.add(key);
  }
  if (accounts.length === 0) throw new ConfigError(`${source}: \`accounts\` is empty`);

  return { version: 1, defaults, accounts, source, warnings, notes: [] };
}
