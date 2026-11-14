import type { ActiveTurn } from './app-runner-types.js';

/** 选模指令的自动续接边界；不在命令、文件修改或工具执行期间中断。 */
export interface ModelTurnSwitchOptions {
  active: () => ActiveTurn | null;
  processing: () => boolean;
  currentContent: () => string;
  reconfiguring: (value: boolean) => void;
  abortAdmission: () => void;
  enqueue: (content: string) => void;
  removeQueued: (content: string) => void;
  interrupt: (turn: ActiveTurn) => Promise<unknown>;
  notice: (content: string) => void;
}

/** 保留新指令和未进入原生线程的请求，当前工具结束后自动开始新模型轮次。 */
export class SessionModelTurnSwitch {
  private queued = new Set<string>();
  constructor(private readonly options: ModelTurnSwitchOptions) {}

  /** 把切换请求排入现有队列；空闲时直接执行，忙时仅中断安全的模型生成。 */
  schedule(content: string): void {
    const o = this.options, busy = o.processing(), turn = o.active();
    if (busy) {
      o.reconfiguring(true);
      if (!turn) {
        content = '因模型设置变化接续原请求，仅补齐未完成事项，不重复已完成操作：\n'
          + o.currentContent() + '\n本次追加：\n' + content;
        o.abortAdmission();
      } else {
        turn.modelSwitchPending = true;
        turn.adaptiveNextModel = undefined;
        turn.modelSwitchCheck = () => { void this.check(turn); };
        if (turn.toolItems?.size) o.notice('当前工具结束后自动切换模型并继续，已保存追加要求。');
      }
    }
    this.queued.add(content);
    o.enqueue(content);
    if (busy && turn) void this.check(turn);
  }

  /** 当前消息已开始执行后，不再属于可取消的待续接队列。 */
  started(content: string): void { this.queued.delete(content); }

  /** 用户取消优先；移除尚未开始的自动接续，配置本身仍保持已保存的选择。 */
  cancel(): void {
    for (const content of this.queued) this.options.removeQueued(content);
    this.queued.clear();
    const turn = this.options.active();
    if (turn) { turn.modelSwitchPending = false; turn.modelSwitchCheck = undefined; }
    this.options.reconfiguring(false);
  }

  /** 重新检查异步追问发送后的工具状态，避免发送中断时已有新工具开始。 */
  private async check(turn: ActiveTurn): Promise<void> {
    const safe = () => this.options.active() === turn && turn.modelSwitchPending && !!turn.turnId && !turn.finished
      && !turn.userInterrupted && !turn.criticalHookFailure && !turn.toolItems?.size && !turn.modelSwitchRequested;
    if (!safe() || turn.modelSwitchInFlight) return;
    turn.modelSwitchInFlight = true;
    try {
      await turn.steerChain;
      if (!safe()) return;
      turn.modelSwitchRequested = true;
      await this.options.interrupt(turn);
    } catch {
      turn.modelSwitchRequested = false;
      this.options.notice('当前轮暂不能中断；设置和追加要求已保存，本轮结束后自动应用。');
    } finally { turn.modelSwitchInFlight = false; }
  }
}
