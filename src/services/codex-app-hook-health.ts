type JsonObject = Record<string, any>;

const UNTRUSTED_STATUSES = new Set(['untrusted', 'modified']);
const CRITICAL_HOOKS = new Set(['sessionStart', 'userPromptSubmit']);

function compactText(value: unknown, maxChars = 240): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
}

export function codexAppHookTrustIssue(response: JsonObject, cwd: string): string | undefined {
  const data = Array.isArray(response?.data) ? response.data : [];
  const entry = data.find((item: JsonObject) => item?.cwd === cwd) ?? data[0];
  if (!entry) return undefined;

  const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  const blocked = hooks.filter((hook: JsonObject) => (
    hook?.enabled !== false
    && hook?.isManaged !== true
    && UNTRUSTED_STATUSES.has(String(hook?.trustStatus ?? ''))
  ));
  const errors = Array.isArray(entry.errors) ? entry.errors.map(compactText).filter(Boolean) : [];
  if (blocked.length === 0 && errors.length === 0) return undefined;

  const names = [...new Set(blocked.map((hook: JsonObject) => String(hook?.eventName ?? 'unknown')))];
  const statuses = [...new Set(blocked.map((hook: JsonObject) => String(hook?.trustStatus ?? 'unknown')))];
  const detail = [
    names.length > 0 ? `事件=${names.join(',')}` : '',
    statuses.length > 0 ? `状态=${statuses.join(',')}` : '',
    errors.length > 0 ? `配置错误=${errors.join('; ')}` : '',
  ].filter(Boolean).join('；');
  return `Codex Hook 未就绪（${detail}），cwd=${cwd}。请在 Codex /hooks 中审阅并信任当前 Hook，然后重试。`;
}

export function codexAppHookFailure(run: JsonObject): { message: string; critical: boolean } | undefined {
  const status = String(run?.status ?? '');
  if (status !== 'failed' && status !== 'blocked') return undefined;
  const eventName = String(run?.eventName ?? 'unknown');
  const entries = Array.isArray(run?.entries) ? run.entries : [];
  const error = entries
    .filter((entry: JsonObject) => entry?.kind === 'error')
    .map((entry: JsonObject) => compactText(entry?.text))
    .find(Boolean);
  const source = compactText(run?.sourcePath, 160);
  return {
    message: `Codex Hook ${eventName} ${status}${error ? `：${error}` : ''}${source ? `（${source}）` : ''}`,
    critical: CRITICAL_HOOKS.has(eventName),
  };
}
