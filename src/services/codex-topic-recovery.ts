import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Recover a topic only from a stored native session-id mapping, then verify
 * that its root still exists in the intended chat. Text similarity is unsafe:
 * different Codex sessions can start with the same question. */
export async function recoverCodexTopic(
  historyDir: string,
  threadId: string,
  larkAppId: string,
  chatId: string,
  getMessage: (messageId: string) => Promise<any>,
): Promise<string | undefined> {
  let files: string[];
  try { files = readdirSync(historyDir).filter(name => name.endsWith('.json')); }
  catch { return undefined; }
  const candidates = new Set<string>();
  for (const name of files) {
    let history: any;
    try { history = JSON.parse(readFileSync(join(historyDir, name), 'utf8')); }
    catch { continue; }
    if (history?.source?.cliSessionId !== threadId || history?.nativeSource?.larkAppId !== larkAppId) continue;
    const root = history.nativeSource.rootMessageId;
    if (typeof root === 'string' && /^om_[a-zA-Z0-9]+$/.test(root)) candidates.add(root);
  }
  const verified: string[] = [];
  for (const root of candidates) {
    // An API failure is retried on the next scan; do not create a duplicate
    // topic while the existing root's status is unknown.
    const detail = await getMessage(root);
    const item = detail?.items?.[0];
    if (!item || item.deleted) throw new Error('Existing Codex topic could not be verified');
    if (item.chat_id !== chatId) continue;
    if ((item.message_id && item.message_id !== root) || item.parent_id || (item.root_id && item.root_id !== root)) {
      throw new Error('Stored Codex topic does not match its Feishu root');
    }
    let text = '';
    try { text = JSON.parse(item.body?.content ?? '{}').text ?? ''; } catch {}
    if (/^\s*<(?:recommended_plugins|environment_context|skills_instructions)(?:\s|>)/.test(text)) continue;
    verified.push(root);
  }
  if (verified.length > 1) throw new Error('Multiple verified Feishu roots for the same Codex session');
  return verified[0];
}
