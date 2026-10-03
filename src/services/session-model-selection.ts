import type { ModelSelection } from './session-model-store.js';

export interface AvailableSessionModel {
  model: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  serviceTiers?: Array<{ id: string }>;
}
export function validateModelSelection(input: unknown, models: AvailableSessionModel[], previous?: ModelSelection): ModelSelection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('model_selection_required');
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !['model', 'effort', 'serviceTier'].includes(k))) throw new Error('unknown_model_option');
  const model = typeof body.model === 'string' ? body.model.trim() : previous?.model;
  const available = models.find(m => m.model === model);
  if (!available) throw new Error('unsupported_model');
  const effort = body.effort ?? previous?.effort ?? available.defaultReasoningEffort;
  if (typeof effort !== 'string' || !available.supportedReasoningEfforts.some(e => e.reasoningEffort === effort)) throw new Error('unsupported_reasoning_effort');
  const serviceTier = body.serviceTier ?? previous?.serviceTier;
  if (serviceTier !== undefined && (typeof serviceTier !== 'string' || !available.serviceTiers?.some(t => t.id === serviceTier))) throw new Error('unsupported_service_tier');
  return { model: available.model, effort, ...(serviceTier !== undefined ? { serviceTier } : {}) };
}
