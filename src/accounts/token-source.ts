import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AccountConfig } from '../types.js';
import { credentialsPath, expandTilde, IS_MACOS } from '../util/paths.js';
import { registerSecret } from '../util/redact.js';

const execFileAsync = promisify(execFile);

export class TokenResolutionError extends Error {
  readonly accountName: string;
  constructor(accountName: string, message: string) {
    super(message);
    this.name = 'TokenResolutionError';
    this.accountName = accountName;
  }
}

/**
 * Token references, in the order they are recognised:
 *
 *   ${VAR}                  environment variable (config-file friendly)
 *   env:VAR                 environment variable (explicit form)
 *   file:/path/to/token     first line of a file
 *   keychain:service/acct   macOS keychain generic password
 *   store[:name]            claudex credential store (~/.config/claudex/credentials.json)
 *   sk-ant-...              literal token
 *
 * Resolution is deliberately lazy: `claudex -p "..."` only ever resolves the
 * token of the account it actually runs, so a broken reference on account #3
 * costs nothing while account #1 is healthy.
 */
export async function resolveToken(account: AccountConfig): Promise<string> {
  const ref = account.token?.trim();
  if (!ref) {
    throw new TokenResolutionError(account.name, `account "${account.name}" has no token configured`);
  }

  const token = await resolveRef(account, ref);
  const trimmed = token.trim();
  if (!trimmed) {
    throw new TokenResolutionError(
      account.name,
      `token reference "${describeRef(ref)}" for account "${account.name}" resolved to an empty value`,
    );
  }
  registerSecret(trimmed);
  return trimmed;
}

async function resolveRef(account: AccountConfig, ref: string): Promise<string> {
  const envBraces = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(ref);
  if (envBraces) return fromEnv(account, envBraces[1] as string);

  if (ref.startsWith('env:')) return fromEnv(account, ref.slice(4).trim());

  if (ref.startsWith('file:')) {
    const path = expandTilde(ref.slice(5).trim());
    try {
      const contents = await readFile(path, 'utf8');
      return contents.split(/\r?\n/, 1)[0] ?? '';
    } catch (error) {
      throw new TokenResolutionError(
        account.name,
        `cannot read token file ${path}: ${(error as Error).message}`,
      );
    }
  }

  if (ref.startsWith('keychain:')) return fromKeychain(account, ref.slice(9).trim());

  if (ref === 'store' || ref.startsWith('store:')) {
    const name = ref === 'store' ? account.name : ref.slice(6).trim() || account.name;
    return fromStore(account, name);
  }

  if (ref.startsWith('sk-ant-')) return ref;

  throw new TokenResolutionError(
    account.name,
    `unrecognised token reference for account "${account.name}": ${describeRef(ref)}\n` +
      `  expected \${VAR}, env:VAR, file:PATH, keychain:SERVICE/ACCOUNT, store, or a literal sk-ant-... token`,
  );
}

function fromEnv(account: AccountConfig, name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new TokenResolutionError(
      account.name,
      `environment variable ${name} is not set (account "${account.name}")`,
    );
  }
  return value;
}

async function fromKeychain(account: AccountConfig, spec: string): Promise<string> {
  if (!IS_MACOS) {
    throw new TokenResolutionError(
      account.name,
      `keychain: token references are only supported on macOS (account "${account.name}")`,
    );
  }
  const slash = spec.indexOf('/');
  const service = slash === -1 ? spec : spec.slice(0, slash);
  const item = slash === -1 ? account.name : spec.slice(slash + 1);
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', service, '-a', item, '-w'],
      { encoding: 'utf8' },
    );
    return stdout;
  } catch (error) {
    throw new TokenResolutionError(
      account.name,
      `keychain item ${service}/${item} not found for account "${account.name}"`,
    );
  }
}

interface CredentialStore {
  version: number;
  tokens: Record<string, string>;
}

async function readStore(): Promise<CredentialStore | null> {
  try {
    const contents = await readFile(credentialsPath(), 'utf8');
    const parsed = JSON.parse(contents) as CredentialStore;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.tokens !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function fromStore(account: AccountConfig, name: string): Promise<string> {
  const store = await readStore();
  const token = store?.tokens[name];
  if (!token) {
    throw new TokenResolutionError(
      account.name,
      `no stored token for "${name}" — run: claudex accounts add --name ${JSON.stringify(name)}`,
    );
  }
  return token;
}

/** Describe a reference without ever echoing a literal token. */
export function describeRef(ref: string): string {
  if (ref.startsWith('sk-ant-')) return '<literal token>';
  return ref;
}
