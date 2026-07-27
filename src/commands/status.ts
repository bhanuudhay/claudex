import { loadContext } from './context.js';
import { formatDuration, RotationEngine } from '../rotation/rotation-engine.js';
import { logger } from '../log/logger.js';
import type { AccountManager } from '../accounts/account-manager.js';

/** Explain which selection rule produced the next account. */
function selectionReason(manager: AccountManager, name: string): string {
  if (manager.state.pinnedAccount === name) return 'pinned by `claudex use`';
  if (manager.state.activeAccount === name) {
    return 'sticky: last successful account — `claudex reset` to release';
  }
  return 'highest priority available';
}

/** `claudex status` — what would run next, and why. */
export async function statusCommand(): Promise<number> {
  const { config, manager } = await loadContext();
  const now = new Date();
  const views = manager.views(now);
  const active = manager.state.activeAccount;
  const eligible = views.filter((view) => view.eligible);

  const out: string[] = [];
  out.push(`config:   ${config.source}`);
  out.push(`accounts: ${views.length} configured, ${eligible.length} available now`);
  out.push(`active:   ${active ?? '(none yet)'}`);
  if (manager.state.pinnedAccount) out.push(`pinned:   ${manager.state.pinnedAccount}`);
  // Report the account that would actually run, and why — priority alone does
  // not decide it, and "why is it still on that account" is the single most
  // common question this command has to answer.
  const next = new RotationEngine(manager).select({ now });
  out.push(`next:     ${next?.name ?? '(none available)'}${next ? `  (${selectionReason(manager, next.name)})` : ''}`);
  if (manager.state.lastRotationReason) {
    out.push(`last:     ${manager.state.lastRotationReason}`);
  }
  if (manager.state.lastSessionId) out.push(`session:  ${manager.state.lastSessionId}`);
  if (manager.state.fdInjectionWorks !== undefined) {
    out.push(`token fd: ${manager.state.fdInjectionWorks ? 'supported' : 'unsupported (using env var)'}`);
  }

  const cooling = views.filter((view) => !view.eligible);
  if (cooling.length > 0) {
    out.push('');
    out.push('unavailable:');
    for (const view of cooling) {
      const until = view.state.cooldownUntil
        ? ` for ${formatDuration(new Date(view.state.cooldownUntil).getTime() - now.getTime())}`
        : '';
      out.push(`  ${view.config.name}: ${view.state.reason ?? view.state.health}${until}`);
    }
  }

  process.stdout.write(out.join('\n') + '\n');
  for (const warning of config.warnings) logger.warn(warning);
  return 0;
}
