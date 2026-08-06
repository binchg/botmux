import type {
  AgentTeamLatestArtifacts,
  AgentTeamMilestone,
  AgentTeamReport,
} from './agent-team-store.js';

export interface AgentTeamHumanOutput {
  title: string;
  markdown: string;
  template: 'blue' | 'green' | 'orange' | 'red' | 'grey';
}

type HumanEvent =
  | { kind: 'milestone'; workerId: string; milestone: AgentTeamMilestone }
  | { kind: 'report'; workerId: string; report: AgentTeamReport };

const HTTP_URL_RE = /https?:\/\/[^\s<>\]]+/giu;
const MAX_DETAIL_CHARS = 180;

export interface AgentTeamDeliveryPolicy {
  userVisible: boolean;
  injectLeader: true;
}

export function agentTeamMilestoneDeliveryPolicy(type: AgentTeamMilestone['type']): AgentTeamDeliveryPolicy {
  return {
    userVisible: type === 'bits_mr_ready' || type === 'build_terminal' || type === 'human_required',
    injectLeader: true,
  };
}

export function agentTeamReportDeliveryPolicy(status: AgentTeamReport['status']): AgentTeamDeliveryPolicy {
  return { userVisible: status === 'blocked', injectLeader: true };
}

/** Worker 话题总能看到已校验终态摘要；leader 卡片仍沿用独立 allowlist。 */
export function agentTeamWorkerFinalDeliveryPolicy(status: AgentTeamReport['status']): AgentTeamDeliveryPolicy {
  return { userVisible: status !== 'invalid' && status !== 'stale', injectLeader: true };
}

function compactLine(value: string, maxChars = MAX_DETAIL_CHARS): string {
  const line = value.replace(HTTP_URL_RE, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(line);
  return chars.length <= maxChars ? line : `${chars.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

function trimUrlTail(value: string): string {
  return value.replace(/[.,;:!，。；！]+$/u, '');
}

export function extractAgentTeamUrls(value: string): string[] {
  return [...value.matchAll(HTTP_URL_RE)]
    .map(match => trimUrlTail(match[0]))
    .filter(Boolean);
}

function queryId(url: URL, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = url.searchParams.get(key)?.trim();
    if (value) return value;
  }
  return undefined;
}

export function agentTeamUrlLabel(rawUrl: string, fallbackIndex = 1): string {
  try {
    const url = new URL(rawUrl);
    const detailId = /\/code\/detail\/(\d+)(?:\/|$)/u.exec(url.pathname)?.[1];
    if (detailId) return `MR ${detailId}`;
    const storyId = /\/story\/detail\/(\d+)(?:\/|$)/u.exec(url.pathname)?.[1];
    if (storyId) return `Meego ${storyId}`;
    const remoteId = /hummer/iu.test(url.hostname) || /remotex/iu.test(rawUrl)
      ? queryId(url, 'id', 'jobId', 'buildId')
      : undefined;
    if (remoteId) return `RemoteX ${remoteId}`;
    const buildJobId = /\/build\/logs/iu.test(url.pathname) ? queryId(url, 'jobId', 'id') : undefined;
    if (buildJobId) return `RemoteX ${buildJobId}`;
    if (/\/(?:wiki|docx)\//u.test(url.pathname)) return '飞书文档';
    if (/github\.com$/iu.test(url.hostname)) return 'GitHub';
    if (/code\.byted\.org$/iu.test(url.hostname)) return 'Code Review';
    if (/bits\.bytedance\.net$/iu.test(url.hostname)) return 'BITS 链接';
    const host = url.hostname.replace(/^www\./iu, '').split('.')[0]?.trim();
    return host ? `${host} 链接` : `链接 ${fallbackIndex}`;
  } catch {
    return `链接 ${fallbackIndex}`;
  }
}

function escapeLinkLabel(value: string): string {
  return value.replace(/([\\\[\]])/gu, '\\$1');
}

function linkMarkdown(url: string, index: number): string {
  return `[${escapeLinkLabel(agentTeamUrlLabel(url, index))}](${url})`;
}

function artifactUrls(artifacts: AgentTeamLatestArtifacts | undefined): string[] {
  return [artifacts?.bitsUrl, artifacts?.buildJob]
    .filter((value): value is string => !!value && /^https?:\/\//iu.test(value));
}

function milestonePresentation(type: AgentTeamMilestone['type']): { icon: string; label: string; template: AgentTeamHumanOutput['template'] } {
  switch (type) {
    case 'audit_eligible': return { icon: '✅', label: '机器审计通过', template: 'green' };
    case 'commit_pushed': return { icon: '✅', label: 'Commit 已推送', template: 'green' };
    case 'bits_mr_ready': return { icon: '✅', label: 'BITS MR 已就绪', template: 'blue' };
    case 'build_started': return { icon: '🟦', label: '构建已开始', template: 'blue' };
    case 'build_terminal': return { icon: '✅', label: '构建已终态', template: 'green' };
    case 'human_required': return { icon: '⚠️', label: '需要人工处理', template: 'orange' };
  }
}

function reportPresentation(status: AgentTeamReport['status']): { icon: string; label: string; template: AgentTeamHumanOutput['template'] } {
  switch (status) {
    case 'succeeded': return { icon: '✅', label: '任务完成', template: 'green' };
    case 'blocked': return { icon: '⚠️', label: '任务阻塞', template: 'orange' };
    case 'interrupted': return { icon: '⏹️', label: '任务已中断', template: 'grey' };
    case 'failed': return { icon: '❌', label: '任务失败', template: 'red' };
    case 'invalid': return { icon: '❌', label: '结果校验失败', template: 'red' };
    case 'stale': return { icon: '⏭️', label: '旧结果已隔离', template: 'grey' };
  }
}

/**
 * Agent Team 的唯一人类可见 renderer。结构化 JSON 永远不进入这里；正文
 * 固定为无空行的短卡，URL 只出现在 Markdown href，显示文字始终是短标签。
 */
export function renderAgentTeamHumanOutput(event: HumanEvent): AgentTeamHumanOutput {
  const record = event.kind === 'milestone' ? event.milestone : event.report;
  const presentation = event.kind === 'milestone'
    ? milestonePresentation(event.milestone.type)
    : reportPresentation(event.report.status);
  const directUrls = [
    ...artifactUrls(record.latestArtifacts),
    event.kind === 'milestone' ? event.milestone.url : undefined,
  ].filter((value): value is string => !!value && /^https?:\/\//iu.test(value));
  const urls = [...new Set([...directUrls, ...extractAgentTeamUrls(record.summary)])];
  const links = urls.map((url, index) => linkMarkdown(url, index + 1)).join(' · ');
  const firstLine = `${presentation.icon} ${links || presentation.label}`;
  const detail = compactLine(record.summary);
  const detailPrefix = event.kind === 'report' && event.report.status === 'blocked' ? '下一步' : '状态';
  const lines = [
    firstLine,
    `范围：${compactLine(event.workerId, 80)}`,
    detail ? `${detailPrefix}：${detail}` : '',
  ].map(line => line.trim()).filter(Boolean).slice(0, 4);
  return {
    title: `Agent Team · ${presentation.label}`,
    markdown: lines.join('\n'),
    template: presentation.template,
  };
}
