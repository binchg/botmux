import type { ModelSelection } from './session-model-store.js';

export interface AvailableSessionModel {
  model: string;
  id?: string;
  configName?: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  serviceTiers?: Array<{ id: string }>;
}
export function normalizeSessionExecutor(value: unknown): 'codex-app' | 'traex' {
  if (value === 'codex' || value === 'codex-app') return 'codex-app';
  if (value === 'traex') return 'traex';
  throw new Error('unsupported_executor');
}
export function validateModelSelection(input: unknown, models: AvailableSessionModel[], previous?: ModelSelection): ModelSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model_selection_required');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !['model', 'effort', 'serviceTier', 'executor'].includes(k))) throw new Error('unknown_model_option');
  const executor = body.executor === undefined ? previous?.executor : normalizeSessionExecutor(body.executor);
  const changedExecutor = (executor ?? 'codex-app') !== (previous?.executor ?? 'codex-app');
  const model = typeof body.model === 'string' ? body.model.trim() : previous?.model;
  const available = models.find(m => m.model === model || m.configName === model || m.id === model);
  if (!available) throw new Error('unsupported_model');
  const effort = body.effort ?? previous?.effort ?? available.defaultReasoningEffort;
  if (typeof effort !== 'string' || !available.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new Error('unsupported_reasoning_effort');
  const serviceTier = body.serviceTier ?? (changedExecutor ? 'default' : previous?.serviceTier);
  if (serviceTier !== undefined && serviceTier !== 'default' && (typeof serviceTier !== 'string' || !available.serviceTiers?.some(t => t.id === serviceTier))) throw new Error('unsupported_service_tier');
  return { model: available.configName ?? available.model, effort, ...(executor ? { executor } : {}), ...(serviceTier !== undefined ? { serviceTier } : {}) };
}
