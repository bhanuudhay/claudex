import { homedir, platform } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

export const IS_WINDOWS = platform() === 'win32';
export const IS_MACOS = platform() === 'darwin';

/** `~` and `~/...` expansion. Leaves everything else untouched. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || (IS_WINDOWS && p.startsWith('~\\'))) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function absolutize(p: string, base = process.cwd()): string {
  const expanded = expandTilde(p);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/** XDG config home, with the Windows equivalent. */
export function configHome(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg && xdg.trim()) return expandTilde(xdg);
  if (IS_WINDOWS) {
    const appData = process.env['APPDATA'];
    if (appData) return appData;
  }
  return join(homedir(), '.config');
}

/**
 * XDG state home, with the Windows equivalent. State is mutable runtime data
 * (which account is active, cooldowns) as opposed to user-authored config.
 */
export function stateHome(): string {
  const xdg = process.env['XDG_STATE_HOME'];
  if (xdg && xdg.trim()) return expandTilde(xdg);
  if (IS_WINDOWS) {
    const local = process.env['LOCALAPPDATA'];
    if (local) return local;
  }
  return join(homedir(), '.local', 'state');
}

export function configDir(): string {
  return join(configHome(), 'claudex');
}

export function stateDir(): string {
  return join(stateHome(), 'claudex');
}

export function statePath(): string {
  return join(stateDir(), 'state.json');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials.json');
}
