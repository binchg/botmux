/** 飞书失败回复的私有持久队列；发送失败与业务任务生命周期完全分离。 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface OutboundRequest {
  method?: string;
  url?: string;
  data?: any;
  params?: any;
  [key: string]: any;
}

export interface PendingReply {
  id: string;
  fingerprint: string;
  request: { method: string; url: string; data: any; params: any; __botmuxPrivacyNotice?: string };
  createdAt: number;
  nextAt: number;
  attempts: number;
  ambiguous: boolean;
  state: 'pending' | 'uncertain' | 'blocked' | 'delivered';
  code?: number | string;
}

/** 只识别飞书消息写入，不把鉴权请求或其它 API 写入队列。 */
export function isMessageWrite(request: OutboundRequest): boolean {
  return ['POST', 'PATCH', 'PUT'].includes(request.method?.toUpperCase() ?? '')
    && /\/im\/v1\/messages(?:\/[^/?]+(?:\/reply)?)?(?:\?|$)/.test(request.url ?? '');
}

/** 返回有限的错误分类，持久文件不记录可能含凭据的原始异常。 */
function failureCode(error: any): number | string {
  return error?.response?.data?.code ?? error?.response?.status ?? error?.code ?? 'network';
}

/** 一次只补发一个记录；失败退避，不占用模型或终端工作进程。 */
export class LarkReplyOutbox {
  private records = new Map<string, PendingReply>();
  private busy = false;
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;

  constructor(private folder: string, private send: (request: OutboundRequest) => Promise<any>,
    private now: () => number = Date.now, private log: (message: string) => void = () => {}) {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(folder).filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
      try {
        const record: PendingReply = JSON.parse(readFileSync(join(folder, file), 'utf8'));
        if (record.id + '.json' === file && isMessageWrite(record.request) && record.state !== 'delivered') this.records.set(record.id, record);
      } catch { this.log('Reply outbox record unreadable; retained for inspection'); }
    }
  }

  /** 仅存相对路由和必要参数；Authorization、Cookie、签名及 SDK 配置永不落盘。 */
  private portable(request: OutboundRequest): PendingReply['request'] {
    const url = new URL(request.url!, 'https://open.feishu.cn');
    const raw = typeof request.data === 'string' ? JSON.parse(request.data) : request.data;
    const params = { ...Object.fromEntries(url.searchParams), ...request.params };
    return { method: request.method!.toUpperCase(), url: url.pathname,
      data: JSON.parse(JSON.stringify(raw)),
      params: params.receive_id_type ? { receive_id_type: params.receive_id_type } : {},
      ...(request.__botmuxPrivacyNotice ? { __botmuxPrivacyNotice: request.__botmuxPrivacyNotice } : {}) };
  }

  /** 给同一待补发回复复用 UUID；正常新回复使用独立 UUID，避免跨轮次误去重。 */
  prepare(request: OutboundRequest): void {
    const portable = this.portable(request);
    const fingerprint = this.fingerprint(portable);
    const pending = [...this.records.values()].find(item => item.fingerprint === fingerprint);
    if (portable.method === 'POST') {
      request.data = { ...portable.data, uuid: pending?.request.data.uuid ?? portable.data.uuid ?? randomUUID() };
    }
    if (pending) request.__botmuxOutboxId = pending.id;
  }

  /** 指纹不包含每次请求生成的 UUID；路由与正文变化仍是不同的回复。 */
  private fingerprint(request: PendingReply['request']): string {
    const { uuid: _uuid, ...data } = request.data;
    // 同一张动态卡片只保留最新更新，恢复后不能用旧快照覆盖最终结果。
    return createHash('sha256').update(JSON.stringify({ ...request,
      data: request.method === 'POST' ? data : {}, __botmuxPrivacyNotice: undefined })).digest('hex');
  }

  /** 以私有权限原子写入，只保存已经脱敏的出站版本。 */
  private persist(record: PendingReply): void {
    const path = join(this.folder, record.id + '.json');
    const temporary = path + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, path);
    this.records.set(record.id, record);
  }

  /** 先保存失败结果，再让调用方处理错误；不会伪造 message_id 或成功回执。 */
  failed(request: OutboundRequest, error: any): void {
    const portable = this.portable(request);
    const fingerprint = this.fingerprint(portable);
    const existing = this.records.get(request.__botmuxOutboxId)
      ?? [...this.records.values()].find(item => item.fingerprint === fingerprint);
    const code = failureCode(error);
    const record: PendingReply = existing ?? { id: randomUUID(), fingerprint, request: portable,
      createdAt: this.now(), nextAt: 0, attempts: 0, ambiguous: false, state: 'pending' };
    record.request = portable;
    record.fingerprint = fingerprint;
    record.attempts++;
    record.code = code;
    record.ambiguous ||= !error?.__botmuxNotSent && (error?.response?.status >= 500
      || (!error?.response && !['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(String(code))));
    record.state = code === 230011 ? 'blocked' : 'pending';
    // 给调用方原有三次短重试留出窗口，再由独立队列接手。
    record.nextAt = this.now() + Math.min(300000, 60000 * 2 ** Math.min(record.attempts - 1, 3));
    this.persist(record);
    this.log(`Reply queued id=${record.id} state=${record.state} attempts=${record.attempts} code=${code}`);
  }

  /** 只有真实成功回执才删除记录；PATCH/PUT 以飞书 code=0 为准。 */
  accepted(request: OutboundRequest, response: any): void {
    if (response?.code !== 0) return;
    if (request.method?.toUpperCase() === 'POST' && !response.data?.message_id) return;
    const portable = this.portable(request);
    const fingerprint = this.fingerprint(portable);
    const record = this.records.get(request.__botmuxOutboxId)
      ?? [...this.records.values()].find(item => item.fingerprint === fingerprint);
    if (!record) return;
    if (portable.method !== 'POST' && record.request.data.content !== portable.data.content) return;
    record.state = 'delivered';
    this.persist(record);
    this.records.delete(record.id);
    unlinkSync(join(this.folder, record.id + '.json'));
    this.log(`Reply delivered id=${record.id} receipt=${response.data?.message_id ?? 'update-accepted'}`);
  }

  /** 顺序补发已到期记录；结果不明超过幂等窗口时保留待核实，避免重复发送。 */
  async drain(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const record = [...this.records.values()].filter(item => item.state === 'pending' && item.nextAt <= this.now())
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!record) return;
      if (record.ambiguous && this.now() - record.createdAt >= 50 * 60000) {
        record.state = 'uncertain';
        this.persist(record);
        this.log(`Reply retained for delivery reconciliation id=${record.id}`);
        return;
      }
      const request = { ...record.request, __botmuxOutboxId: record.id, __botmuxOutboxReplay: true, timeout: 10000 };
      try {
        const response = await this.send(request);
        if (response?.code !== 0 || (request.method === 'POST' && !response.data?.message_id)) {
          throw { response: { data: { code: response?.code || 'missing_receipt' } } };
        }
        this.accepted(request, response);
      } catch (error) {
        // SDK 拦截器负责即时路径，补发路径在此统一计数，防止重复入队。
        this.failed((error as any)?.config ?? request, error);
      }
    } finally { this.busy = false; }
  }

  /** 后台定时器有界且可停止；失败不会向业务事件循环抛出异常。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      try { await this.drain(); } catch { this.log('Reply outbox drain failed; pending records retained'); }
      if (this.running) {
        this.timer = setTimeout(tick, 5000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(tick, 5000);
    this.timer.unref();
  }

  /** 停止投递调度不会清理待发送记录。 */
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }

  /** 只回读数量及状态，诊断页无需暴露正文或个人资料。 */
  status(): Record<string, number> {
    const counts = { pending: 0, uncertain: 0, blocked: 0 };
    for (const item of this.records.values()) if (item.state !== 'delivered') counts[item.state]++;
    return counts;
  }
}
