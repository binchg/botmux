/** 卡片回调类型与平台操作者身份解析；由 card-handler.ts 拆分，来源 c397c9af。 */
import type { DaemonSession } from '../../core/types.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import { type WorkflowApprovalHandlerDeps } from './workflow-card-handler.js';
import { type V3GateCardHandlerDeps } from './v3-gate-card-handler.js';
import { type V3BlockedCardHandlerDeps } from './v3-blocked-card-handler.js';
import { type V3LoopGrantCardHandlerDeps } from './v3-loop-grant-card-handler.js';
import { type V3RevisitGrantCardHandlerDeps } from './v3-revisit-grant-card-handler.js';
import { resolveUserUnionId as defaultResolveUserUnionId } from './client.js';

export interface CardHandlerDeps {
  activeSessions: Map<string, DaemonSession>;
  sessionReply: (rootId: string, content: string, msgType?: string, larkAppId?: string, turnId?: string) => Promise<string>;
  lastRepoScan: Map<string, ProjectInfo[]>;
  workflowApprovalDeps?: WorkflowApprovalHandlerDeps;
  workflowApprovalResolved?: (runId: string) => void | Promise<void>;
  /** v3 humanGate 审批卡点击处理（driveRun 由 daemon 接的 v3 gate runner 提供）. */
  v3GateDeps?: V3GateCardHandlerDeps;
  /** v3 blocked 重试卡点击处理（同一个 runner 的 driveRun）. */
  v3BlockedDeps?: V3BlockedCardHandlerDeps;
  /** v3 loop 追加一轮卡点击处理（同一个 runner 的 driveRun）. */
  v3LoopGrantDeps?: V3LoopGrantCardHandlerDeps;
  /** v3 回溯预算准许卡点击处理（同一个 runner 的 driveRun）. */
  v3RevisitGrantDeps?: V3RevisitGrantCardHandlerDeps;
}

/**
 * Lark card action callback envelope.
 *
 * Exported so module-specific dashboard handlers can share the callback type
 * without redeclaring it.
 *
 * Trust model:
 *   - `operator.open_id` and `operator.union_id` are Lark-verified payload
 *     fields. Treat them as the only legitimate source of caller identity.
 *   - `action.value` is round-tripped from the card schema and IS NOT
 *     verified by Lark. NEVER read identity fields (`union_id`, `open_id`,
 *     `user_id`, …) from `action.value`.
 */
export interface CardActionData {
  operator?: {
    open_id?: string;
    /** Lark-verified union_id, present on card v2 callbacks where the tenant
     *  enables `with_union_id`. Absent when Lark doesn't carry it; callers
     *  fall back to `resolveUserUnionId` via `resolveCardOperatorUnionId`. */
    union_id?: string;
  };
  action?: {
    value?: Record<string, string>;
    option?: unknown;
    options?: unknown;
    form_value?: Record<string, unknown>;  // V2 form input values
  };
  context?: { open_message_id?: string };
  open_message_id?: string;
}

/** Resolved operator identity returned by `resolveCardOperatorUnionId`. */
export interface CardOperatorIdentity {
  /** Verified `on_`-prefixed union_id, or `undefined` when verification fails. */
  unionId?: string;
  /** The verified `operator.open_id` echoed back for audit/log purposes. Never
   *  used as an authn/authz proxy when `unionId` is absent. */
  openId?: string;
}

/** Optional deps for `resolveCardOperatorUnionId` — production omits, tests
 *  inject a fake `resolveUserUnionId` to avoid hitting the Lark contact API. */
export interface ResolveCardOperatorUnionIdDeps {
  resolveUserUnionId?: (larkAppId: string, openId: string) => Promise<{ unionId?: string; name?: string }>;
}

/**
 * Resolve the verified `union_id` of the operator who clicked a card button.
 *
 * Three-state semantics:
 *  1. `operator.union_id` starts with `on_` → trust it directly.
 *  2. `operator.union_id` is present but does NOT start with `on_` (e.g.
 *     `ou_xxx`, malformed) → reject; do NOT fallback. Trusting `open_id`
 *     after a malformed verified field would be a bypass.
 *  3. `operator.union_id` is absent → fall back to
 *     `resolveUserUnionId(larkAppId, openId)`, accepting only `on_`-prefixed
 *     results.
 *
 * In every failure mode (missing open_id, fallback returns no unionId,
 * fallback throws) the function returns `{ openId }` with `unionId` left
 * undefined, so callers fail closed.
 *
 * `action.value` is NEVER read here — see the unit tests that pin that
 * contract.
 */
export async function resolveCardOperatorUnionId(
  data: CardActionData,
  larkAppId: string,
  deps: ResolveCardOperatorUnionIdDeps = {},
): Promise<CardOperatorIdentity> {
  const openId = data.operator?.open_id;
  if (!openId) return {};
  const verified = data.operator?.union_id;
  if (typeof verified === 'string') {
    // Verified field present — must be on_ prefix or we reject. Fallback is
    // deliberately skipped: a malformed verified identity is a stronger
    // negative signal than its absence.
    if (verified.startsWith('on_')) return { unionId: verified, openId };
    return { openId };
  }
  // Verified field absent — fallback to the contact API. Wrapped in try/catch
  // so resolver errors don't bubble up and surprise card-callback paths.
  const resolver = deps.resolveUserUnionId ?? defaultResolveUserUnionId;
  try {
    const { unionId } = await resolver(larkAppId, openId);
    if (typeof unionId === 'string' && unionId.startsWith('on_')) {
      return { unionId, openId };
    }
    return { openId };
  } catch {
    return { openId };
  }
}
