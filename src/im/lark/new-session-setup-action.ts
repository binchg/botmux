import { CARD_ACTION_UNHANDLED, type SessionCardContext } from './card-action-context.js';
import { config } from '../../config.js';
import { readSessionModel, writeSessionModel } from '../../services/session-model-store.js';
import { validateModelSelection } from '../../services/session-model-selection.js';
import { announcePendingRepoSession } from '../../core/session-activity.js';
import { getSessionWorkingDir } from '../../core/session-manager.js';
import { buildNewSessionDirectoryCard, buildNewSessionModelCard, buildNewSessionSetupCard, newSessionModelCatalog, pendingNewSessionModelSetup } from './new-session-setup.js';
import { deleteMessage } from './client.js';
import { validateWorkingDir } from '../../core/working-dir.js';
import { commitRepoSelection } from './card-action-repo-selection.js';

export async function handleNewSessionSetupAction(ctx: SessionCardContext): Promise<any> {
  const { actionType, ds, value, action, rootId, activeSessions, sKey, cardMessageId, larkAppId, operatorOpenId, sessionReply, lastRepoScan } = ctx;
  if (!['new_session_model_set', 'new_session_model_next', 'new_session_model_retry', 'new_session_directory_select', 'new_session_quick_start', 'new_session_customize'].includes(actionType)) return CARD_ACTION_UNHANDLED;
  const error = (content: string) => ({ toast: { type: 'error', content } });
  if (!ds?.pendingRepo || ds.session.status !== 'active') return error('此创建卡片已过期，请使用当前会话卡片');
  const id = ds.session.sessionId;
  const stillActive = () => activeSessions.get(sKey) === ds && ds.session.sessionId === id && !!ds.pendingRepo && ds.session.status === 'active';
  if (actionType === 'new_session_directory_select') {
    if (pendingNewSessionModelSetup(ds)) return error('请先确认模型、推理和 Fast');
    const path = action?.option ?? value.working_dir;
    if (typeof path !== 'string') return error('请选择工作目录');
    const validation = validateWorkingDir(path);
    if (!validation.ok) return error(validation.error);
    if (ds.worktreeCreating) return error('工作区创建尚未结束，请稍后再选');
    await commitRepoSelection({ ds, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply }, validation.resolvedPath, validation.resolvedPath);
    return { toast: { type: 'success', content: '已选择工作目录并启动会话' } };
  }
  if (!pendingNewSessionModelSetup(ds)) return error('模型已确认，请在下一步选择工作目录');
  if (actionType === 'new_session_model_retry') {
    const card = await buildNewSessionSetupCard(ds, lastRepoScan.get(ds.chatId) ?? [], rootId, getSessionWorkingDir(ds));
    if (!stillActive()) return error('会话已关闭或更新');
    return { card: { type: 'raw', data: JSON.parse(card) } };
  }
  try {
    const { models } = await newSessionModelCatalog(ds);
    if (!stillActive() || !pendingNewSessionModelSetup(ds)) return error('此创建卡片已过期');
    const previous = readSessionModel(config.session.dataDir, id);
    if (actionType === 'new_session_customize') return { card: { type: 'raw', data: JSON.parse(buildNewSessionModelCard(ds, rootId, models, true)) } };
    if (actionType === 'new_session_quick_start') {
      if (!previous || typeof value.working_dir !== 'string') return error('请先选择模型和目录');
      validateModelSelection(previousSelection(previous), models);
      const validation = validateWorkingDir(value.working_dir);
      if (!validation.ok) return error(validation.error);
      ds.session.pendingRepoSelection = { ...ds.session.pendingRepoSelection, modelSetupPending: false, modelConfirmed: true };
      announcePendingRepoSession(ds);
      await commitRepoSelection({ ds, rootId, cardMessageId, larkAppId, operatorOpenId, activeSessions, sessionReply }, validation.resolvedPath, validation.resolvedPath);
      return { toast: { type: 'success', content: '已确认配置并启动会话' } };
    }
    if (actionType === 'new_session_model_set') {
      if (!['model', 'effort', 'serviceTier'].includes(value.field) || typeof action?.option !== 'string') return error('无效的模型选项');
      const patch: Record<string, string> = { [value.field]: action.option };
      if (value.field === 'model') {
        const target = models.find(m => (m.configName ?? m.model) === action.option);
        if (!target) return error('该模型当前不可用');
        patch.effort = target.supportedReasoningEfforts.some(e => e.reasoningEffort === previous?.effort) ? previous!.effort : target.defaultReasoningEffort;
        patch.serviceTier = previous?.serviceTier === 'priority' && target.serviceTiers?.some(t => t.id === 'priority') ? 'priority' : 'default';
      }
      writeSessionModel(config.session.dataDir, id, validateModelSelection(patch, models, previous));
      return { toast: { type: 'success', content: '已保存本次会话配置' }, card: { type: 'raw', data: JSON.parse(buildNewSessionModelCard(ds, rootId, models, true)) } };
    }
    if (!previous) return error('请先选择模型');
    validateModelSelection(previousSelection(previous), models);
    // Send the form as a fresh card (forms cannot be patched in-place). Keep the
    // model stage durable until sending succeeds, so retry survives failure.
    const card = buildNewSessionDirectoryCard(ds, lastRepoScan.get(ds.chatId) ?? [], rootId, getSessionWorkingDir(ds));
    const messageId = await sessionReply(rootId, card, 'interactive');
    if (!stillActive() || !pendingNewSessionModelSetup(ds)) {
      if (larkAppId) await deleteMessage(larkAppId, messageId).catch(() => {});
      return error('此创建卡片已过期');
    }
    ds.session.pendingRepoSelection = { ...ds.session.pendingRepoSelection, modelSetupPending: false, modelConfirmed: true };
    ds.repoCardMessageId = messageId;
    announcePendingRepoSession(ds);
    if (cardMessageId && larkAppId) await deleteMessage(larkAppId, cardMessageId).catch(() => {});
    return { toast: { type: 'success', content: '请选择工作目录' } };
  } catch { return error('模型配置读取或保存失败，请重试'); }
}
function previousSelection(value: import('../../services/session-model-store.js').ModelSelection) {
  const { model, effort, serviceTier, executor, hookTrust, routingMode } = value;
  return { model, effort, serviceTier, executor, hookTrust, routingMode };
}
