import { execFile } from 'node:child_process';

export interface TraexCatalogModel {
  model: string;
  displayName: string;
  loadPercent?: number;
  queueSize?: number;
  efforts: string[];
}

/** 仅保留路由元数据，不保存目录中的提示词、凭据或会话内容。 */
export function parseTraexCatalog(value: any): TraexCatalogModel[] {
  if (!Array.isArray(value?.models)) throw new Error('traex_invalid_model_catalog');
  return value.models.filter((m: any) => m.visibility === 'list' && m.model_provider_id === 'trae')
    .map((m: any) => {
      const load = m.business_metadata?.load;
      const finite = (n: unknown): number | undefined => typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
      return { model: String(m.config_name ?? m.slug).toLowerCase(), displayName: String(m.slug),
        loadPercent: finite(load?.load_percent), queueSize: finite(load?.queue_size),
        efforts: (m.supported_reasoning_levels ?? []).map((r: any) => r.effort) };
    });
}

/** --remote 强制刷新；超时或缺失数据不冒充零负载。 */
export function fetchTraexCatalog(bin = process.env.TRAEX_APP_SERVER_BIN || 'traex', cwd = process.cwd()): Promise<TraexCatalogModel[]> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['debug', 'models', '--remote'], { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error('traex_catalog_unavailable')); return; }
      try { resolve(parseTraexCatalog(JSON.parse(stdout))); }
      catch { reject(new Error('traex_invalid_model_catalog')); }
    });
  });
}

export function eligibleTraexModels(models: TraexCatalogModel[], effort = 'xhigh'): string[] {
  return models.filter(m => m.loadPercent !== undefined && m.loadPercent < 100
    && !(m.queueSize !== undefined && m.queueSize > 0) && m.efforts.includes(effort)).map(m => m.model);
}
