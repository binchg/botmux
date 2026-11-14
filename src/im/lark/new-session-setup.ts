import { readSessionStartPreferences } from '../../services/session-start-preferences.js';
import { config } from '../../config.js';
import { getBot } from '../../bot-registry.js';
import type { DaemonSession } from '../../core/types.js';
import { announcePendingRepoSession } from '../../core/session-activity.js';
import { readCodexAppModelSetup } from '../../services/codex-app-threads.js';
import { readSessionModel, writeSessionModel } from '../../services/session-model-store.js';
import { validateModelSelection } from '../../services/session-model-selection.js';
import type { AvailableSessionModel } from '../../services/session-model-selection.js';
import { listSessions } from '../../services/session-store.js';
import { sessionWorkingDirChoices } from '../../services/session-working-dir-choices.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import { buildRepoSelectCard } from './card-builder.js';
import { localeForBot } from '../../i18n/index.js';

export function requiresNewSessionModelSetup(ds: DaemonSession): boolean {
  return !!getBot(ds.larkAppId).config.requireWorkingDirSelection
    && (ds.session.cliId ?? getBot(ds.larkAppId).config.cliId) === 'codex-app'
    && !ds.adoptedFrom && !ds.initConfig?.adoptMode;
}
export function pendingNewSessionModelSetup(ds: DaemonSession): boolean {
  return !!ds.pendingRepo && requiresNewSessionModelSetup(ds) && !ds.session.pendingRepoSelection?.modelConfirmed;
}

export function lastSessionSetupDirectory(ds: DaemonSession): string | undefined {
  const previous = readSessionStartPreferences(config.session.dataDir, ds.larkAppId);
  if (previous) {
    const usable = sessionWorkingDirChoices([], ds.larkAppId, [previous.workingDir]).configured[0];
    if (usable) return usable;
  }
  return sessionWorkingDirChoices(listSessions(), ds.larkAppId).recent[0];
}

export function buildNewSessionDirectoryCard(ds: DaemonSession, projects: ProjectInfo[], rootId: string, currentPath: string): string {
  const bot = getBot(ds.larkAppId), cfg = bot.config;
  const card = JSON.parse(buildRepoSelectCard(projects, currentPath, rootId, localeForBot(ds.larkAppId), cfg.worktreeMultiPicker, cfg.requireWorkingDirSelection));
  if (!cfg.requireWorkingDirSelection) return JSON.stringify(card);
  const en = localeForBot(ds.larkAppId) === 'en';
  card.header.title.content = en ? 'Step 2/2 · Working directory' : '第 2/2 步 · 选择工作目录';
  if (!requiresNewSessionModelSetup(ds)) card.header.title.content = en ? 'Choose a working directory' : '选择工作目录';
  const choices = sessionWorkingDirChoices(listSessions(), ds.larkAppId, [
    ...(cfg.workingDirPresets ?? []), ...(cfg.workingDirs ?? []), ...(cfg.defaultWorkingDir ? [cfg.defaultWorkingDir] : []),
    ...(cfg.defaultOncall?.workingDir ? [cfg.defaultOncall.workingDir] : []),
  ]);
  const quick = (label: string, paths: string[]) => paths.length ? [
    { tag: 'div', text: { tag: 'plain_text', content: label } },
    { tag: 'action', actions: [{ tag: 'select_static', placeholder: { tag: 'plain_text', content: label },
      options: paths.map(path => ({ text: { tag: 'plain_text', content: path }, value: path })),
      value: { action: 'new_session_directory_select', root_id: rootId, session_id: ds.session.sessionId, cli_id: ds.session.cliId ?? cfg.cliId },
    }] },
  ] : [];
  const lastDir = lastSessionSetupDirectory(ds);
  if (lastDir) card.elements.unshift({ tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: en ? 'Use last directory' : '确认使用上次目录' }, value: { action: 'new_session_directory_select', root_id: rootId, session_id: ds.session.sessionId, working_dir: lastDir } }] }, { tag: 'div', text: { tag: 'plain_text', content: lastDir } });
  card.elements.unshift(...quick(en ? 'Recently used' : '最近使用（最多 5 个）', choices.recent), ...quick(en ? 'Configured directories' : '预设目录', choices.configured));
  // Existing repo controls remain available; bind them to this generation too.
  const bind = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.value && typeof node.value === 'object' && node.value.root_id === rootId) node.value.session_id = ds.session.sessionId;
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(bind); else if (child && typeof child === 'object') bind(child);
  };
  bind(card);
  const selection = readSessionModel(config.session.dataDir, ds.session.sessionId);
  if (selection) card.elements.unshift({ tag: 'div', text: { tag: 'plain_text', content: `${selection.model} · ${selection.effort} · Fast ${selection.serviceTier === 'priority' ? 'ON' : 'OFF'}` } });
  return JSON.stringify(card);
}

export function buildNewSessionModelCard(ds: DaemonSession, rootId: string, models: AvailableSessionModel[], expanded = false): string {
  const en = localeForBot(ds.larkAppId) === 'en';
  const selection = readSessionModel(config.session.dataDir, ds.session.sessionId);
  const selected = models.find(m => (m.configName ?? m.model) === selection?.model || m.model === selection?.model);
  const base = { root_id: rootId, session_id: ds.session.sessionId, cli_id: 'codex-app' };
  const select = (field: string, label: string, options: string[], current?: string) => ({ tag: 'action', actions: [{
    tag: 'select_static', placeholder: { tag: 'plain_text', content: label },
    ...(current && options.includes(current) ? { initial_option: current } : {}),
    options: options.map(value => ({ text: { tag: 'plain_text', content: field === 'serviceTier' ? `Fast ${value === 'priority' ? 'ON' : 'OFF'}` : value }, value })),
    value: { ...base, action: 'new_session_model_set', field },
  }] });
  const previousDir = lastSessionSetupDirectory(ds);
  const elements: any[] = [
    { tag: 'div', text: { tag: 'plain_text', content: selection
      ? `${selection.model} · ${selection.effort} · Fast ${selection.serviceTier === 'priority' ? 'ON' : 'OFF'}${previousDir ? `\n📁 ${previousDir}` : ''}`
      : (en ? 'Choose settings for this session' : '请选择本次会话配置') } },
    { tag: 'div', text: { tag: 'plain_text', content: en ? 'Confirm to start, or customize. Your confirmed settings will be remembered for next time.' : '确认即可开始，也可自定义。实际确认的配置会记作下次默认。' } },
  ];
  if (selection && previousDir) elements.push({ tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: en ? 'Confirm and start' : '确认配置并开始' }, value: { ...base, action: 'new_session_quick_start', working_dir: previousDir } }] });
  if (!expanded && previousDir) {
    elements.push({ tag: 'action', actions: [{ tag: 'button', type: previousDir ? 'default' : 'primary', text: { tag: 'plain_text', content: en ? 'Customize model and directory' : '自定义模型与目录' }, value: { ...base, action: 'new_session_customize' } }] });
    return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: en ? 'New session · Confirm settings' : '新会话 · 确认模型与工作目录' } }, elements });
  }
  elements.push(
    select('model', en ? 'Model' : '模型', [...new Set(models.map(m => m.configName ?? m.model))], selection?.model));
  if (selected) elements.push(select('effort', en ? 'Reasoning' : '推理强度', selected.supportedReasoningEfforts.map(e => e.reasoningEffort), selection?.effort),
    select('serviceTier', 'Fast', ['default', ...(selected.serviceTiers?.some(t => t.id === 'priority') ? ['priority'] : [])], selection?.serviceTier));
  elements.push({ tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: en ? 'Next · Working directory' : '下一步：选择工作目录' }, value: { ...base, action: 'new_session_model_next' } }] });
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'blue', title: { tag: 'plain_text', content: en ? 'Step 1/2 · Model / Reasoning / Fast' : '第 1/2 步 · 模型 / 推理 / Fast' } }, elements });
}

export async function newSessionModelCatalog(ds: DaemonSession) {
  return readCodexAppModelSetup({ codexBin: ds.initConfig?.cliPathOverride ?? getBot(ds.larkAppId).config.cliPathOverride, cwd: ds.workingDir ?? ds.session.workingDir ?? process.env.HOME ?? process.cwd() });
}

/** All first-session ingress paths share this gate. Never starts a runner. */
export async function buildNewSessionSetupCard(ds: DaemonSession, projects: ProjectInfo[], rootId: string, currentPath: string): Promise<string> {
  if (!pendingNewSessionModelSetup(ds)) return buildNewSessionDirectoryCard(ds, projects, rootId, currentPath);
  ds.session.pendingRepoSelection = { ...ds.session.pendingRepoSelection, modelSetupPending: true };
  announcePendingRepoSession(ds);
  try {
    const { models, defaults } = await newSessionModelCatalog(ds);
    if (!readSessionModel(config.session.dataDir, ds.session.sessionId)) {
      const previous = readSessionStartPreferences(config.session.dataDir, ds.larkAppId)?.selection;
      const candidates = [previous, ...(defaults.model ? [{ model: defaults.model, effort: defaults.model_reasoning_effort, serviceTier: defaults.service_tier ?? 'default' }] : [])];
      for (const candidate of candidates) {
        if (!candidate) continue;
        try {
          writeSessionModel(config.session.dataDir, ds.session.sessionId, validateModelSelection(candidate, models));
          break;
        } catch { /* Unavailable previous/default model: let the user choose. */ }
      }
    }
    return buildNewSessionModelCard(ds, rootId, models);
  } catch {
    return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'orange', title: { tag: 'plain_text', content: '第 1/2 步 · 模型配置暂不可用' } }, elements: [
      { tag: 'div', text: { tag: 'plain_text', content: '会话已保留，请重试读取模型配置。' } },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '重试' }, value: { action: 'new_session_model_retry', root_id: rootId, session_id: ds.session.sessionId, cli_id: 'codex-app' } }] },
    ] });
  }
}
