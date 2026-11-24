import type { SessionModelRuntime } from './session-model-store.js';

/** app-server 运行器的输入、轮次和协议状态。 */
export type JsonObject = Record<string, any>;

export interface Args {
  sessionId: string;
  codexBin: string;
  traexBin: string;
  cwd: string;
  threadId?: string;
  title?: string;
  botName?: string;
  botOpenId?: string;
  locale?: string;
}

export interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

export interface ActiveTurn {
  turnId?: string;
  startedAtMs: number;
  finalText: string;
  finalItemId?: string;
  allAgentText: string;
  itemText: Map<string, string>;
  itemEpoch: Map<string, number>;
  emittedProgressItemIds: Set<string>;
  guidanceEpoch: number;
  pendingSteers: string[];
  steerChain: Promise<void>;
  done: Promise<void>;
  resolveDone: () => void;
  criticalHookFailure?: string;
  turnFailed?: boolean;
  /** 上游明确失败的原始分类依据，只用于当前轮准入判断。 */
  providerError?: string;
  /** 基于实际 assistant delta 记录首 token，不用运行器提示或队列心跳代替。 */
  firstTokenAtMs?: number;
  rateLimitError?: string;
  quotaExhaustedError?: string;
  /** refresh token 已被同机其它 app-server 轮换，且本轮尚无任何模型或工具副作用。 */
  authRotationError?: string;
  /** 结构化 Team JSON 仅供机器使用，聚合到终态标记，不向终端或进度转发流式片段。 */
  structuredOutput: boolean;
  modelRuntime?: SessionModelRuntime;
  adaptiveNextModel?: string;
  adaptiveChecking?: boolean;
  adaptiveCheck?: () => void;
  adaptiveActivityAt?: number;
  userInterrupted?: boolean;
  finished?: boolean;
  adaptiveFloorNotified?: boolean;
  toolItems?: Set<string>;
  modelSwitchPending?: boolean;
  modelSwitchInFlight?: boolean;
  modelSwitchRequested?: boolean;
  modelSwitchCheck?: () => void;
}

export interface TurnOutcome {
  adaptiveNextModel?: string;
  turnId?: string;
  startedAtMs: number;
  rateLimitError?: string;
  authRotationError?: string;
  unavailableModelReply?: string;
}
