import { loadContext } from './context.js';
import { formatDuration } from '../rotation/rotation-engine.js';
import { logger } from '../log/logger.js';

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
  out.push(`next:     ${eligible[0]?.config.name ?? '(none available)'}`);
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
