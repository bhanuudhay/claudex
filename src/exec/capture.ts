import { spawn, type StdioOptions } from 'node:child_process';
import type { SpawnMods } from '../accounts/providers/provider.js';
import { CHILD_ENV_MARKER } from './resolve-claude.js';

export interface CaptureResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI and capture its output instead of forwarding it.
 *
 * Used by health checks and diagnostics, never on the passthrough path — the
 * passthrough path must stream, this one must collect.
 */
export function captureClaude(
  binary: string,
  args: string[],
  mods: SpawnMods,
  timeoutMs = 30_000,
): Promise<CaptureResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...mods.env, [CHILD_ENV_MARKER]: '1' };
  for (const key of mods.unsetEnv) delete env[key];

  const stdio: StdioOptions = ['ignore', 'pipe', 'pipe', ...mods.extraStdio];
  const child = spawn(binary, args, { stdio, env, windowsHide: true });

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  mods.onSpawn?.(child);

  return new Promise<CaptureResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exitCode: null, stdout, stderr: stderr + '\n[claudex] health check timed out' });
    }, timeoutMs);
    timer.unref?.();

    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}
