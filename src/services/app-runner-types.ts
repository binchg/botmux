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
  rateLimitError?: string;
  quotaExhaustedError?: string;
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
}
