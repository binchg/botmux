import type { ModelSelection } from './session-model-store.js';

export interface AvailableSessionModel {
  model: string;
  executor?: 'codex-app' | 'traex' | 'ark' | 'gateway';
  displayName?: string;
  id?: string;
  configName?: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  serviceTiers?: Array<{ id: string }>;
}
export function normalizeSessionExecutor(value: unknown): 'codex-app' | 'traex' | 'ark' | 'gateway' {
  if (value === 'codex' || value === 'codex-app') return 'codex-app';
  if (value === 'traex' || value === 'ark' || value === 'gateway') return value;
  throw new Error('unsupported_executor');
}
export function validateModelSelection(input: unknown, models: AvailableSessionModel[], previous?: ModelSelection): ModelSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model_selection_required');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !['model', 'effort', 'serviceTier', 'executor', 'hookTrust', 'routingMode'].includes(k))) throw new Error('unknown_model_option');
  const routingMode = body.routingMode ?? (body.model !== undefined ? 'fixed' : previous?.routingMode);
  if (routingMode !== undefined && !['fixed', 'adaptive'].includes(String(routingMode))) throw new Error('unsupported_routing_mode');
  const hookTrust = body.hookTrust ?? previous?.hookTrust;
  if (hookTrust !== undefined && hookTrust !== 'always' && hookTrust !== 'review') throw new Error('unsupported_hook_trust');
  let executor = body.executor === undefined ? previous?.executor : normalizeSessionExecutor(body.executor);
  const model = typeof body.model === 'string' ? body.model.trim() : previous?.model;
  const matches = (m: AvailableSessionModel) => (m.model === model || m.configName === model || m.id === model)
    && (!body.executor || !m.executor || m.executor === executor);
  const available = models.find(m => matches(m) && m.id === model)
    ?? models.find(m => matches(m) && m.executor === executor) ?? models.find(matches);
  if (!available) throw new Error('unsupported_model');
  if (available.executor) executor = available.executor;
  const changedExecutor = (executor ?? 'codex-app') !== (previous?.executor ?? 'codex-app');
  const effort = body.effort ?? previous?.effort ?? available.defaultReasoningEffort;
  if (typeof effort !== 'string' || !available.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new Error('unsupported_reasoning_effort');
  const serviceTier = body.serviceTier ?? (changedExecutor ? 'default' : previous?.serviceTier);
  if (serviceTier !== undefined && serviceTier !== 'default' && (typeof serviceTier !== 'string' || !available.serviceTiers?.some(t => t.id === serviceTier))) throw new Error('unsupported_service_tier');
  return { model: available.configName ?? available.model, effort, ...(executor ? { executor } : {}), ...(serviceTier !== undefined ? { serviceTier } : {}), ...(hookTrust ? { hookTrust } : {}), ...(routingMode ? { routingMode: routingMode as 'fixed' | 'adaptive' } : {}) };
}
