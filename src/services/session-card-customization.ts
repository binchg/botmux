/** 按机器人保存会话卡定制；仅影响展示，不修改权限、模型路由或消息正文来源。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionCardCustomization { compactButtons?: boolean; modelInCard?: boolean }

/** 未配置、损坏或未命中的机器人沿用原布局。 */
export function readSessionCardCustomization(dir: string, appId?: string): SessionCardCustomization {
  if (!appId) return {};
  try { return JSON.parse(readFileSync(join(dir, 'session-card-customization.json'), 'utf8')).bots?.[appId] ?? {}; }
  catch { return {}; }
}

/** 出站时统一精简新卡与旧卡的补发，正文只移除工具自动添加的模型首行。 */
export function customizeSessionCard(content: string, prefs: SessionCardCustomization): string {
  if (!prefs.compactButtons && !prefs.modelInCard) return content;
  let card: any;
  try { card = JSON.parse(content); } catch { return content; }
  const modelHeader = /^> \*\*(?:模型：)?TraeX · [^\n]+\*\*(?:\n\n|$)/u;
  if (prefs.modelInCard) {
    const clean = (value: any): void => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && ['content', 'text'].includes(key)) value[key] = child.replace(modelHeader, '');
        else if (child && typeof child === 'object') clean(child);
      }
    };
    clean(card);
  }
  // 只处理含 Web 终端入口的会话卡，保留提问、审批和模型选择面板。
  const elements = card.elements;
  const sessionCard = Array.isArray(elements)
    && elements.some((row: any) => row.text?.content?.startsWith('📁 '))
    && elements.some((row: any) => row.tag === 'action'
      && row.actions?.some((action: any) => action.tag === 'button' && action.multi_url));
  if (prefs.compactButtons && sessionCard) {
    for (const row of elements) {
      if (row.tag !== 'action') continue;
      row.actions = row.actions.filter((action: any) => action.tag === 'button'
        && !action.value && /^https?:\/\//.test(action.multi_url?.url ?? action.url ?? ''));
    }
    card.elements = elements.filter((row: any) => row.tag !== 'action' || row.actions.length);
  }
  return JSON.stringify(card);
}
