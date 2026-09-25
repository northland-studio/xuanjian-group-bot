/**
 * 支付播报服务：待审批轮询 + 财务月报 + 文字周报
 *
 * 设计约束（与官网契约一致）：
 * - 机器人只做「提醒 / 出图 / 转发审批动作」，不新增任何扣款或代确认接口；
 * - 每次播报对官网的请求数 ≤ 3（月报 2 次：render-url + pending-approvals；周报 1 次：贡献榜）；
 * - 请求失败静默退避（指数增长到 8 分钟），不刷日志、不高频重试；
 * - 任何异常都被吞掉并转为日志，绝不因某个群/某次失败抛出未捕获异常；
 * - 全部能力由 PAY_BROADCAST=on 控制，缺省关闭。
 */
import { Structs } from 'node-napcat-ts';
import type { SendMessageSegment } from 'node-napcat-ts';
import { config, broadcastGroup, approvalGroup } from '../config.js';
import * as api from './officialApi.js';
import { read, write } from './store.js';
import { activityRangeRanking } from './activity.js';
import { shanghaiNow, isDue, jobKey } from './schedule.js';
import type { ScheduledJob } from './schedule.js';

/** 向群发送消息（由 index.ts 注入 NapCat 调用，便于干跑时替换成 mock） */
export type GroupSender = (groupId: number, message: SendMessageSegment[]) => Promise<unknown>;

interface BroadcastState {
  /** 已经播报过的待审批流水 ID（字符串，避免重启后重复播报） */
  announcedApprovals?: string[];
  /** 已触发过的定时任务状态键 */
  fired?: Record<string, string>;
}

const STATE_FILE = 'pay-broadcast';
/** 待审批轮询间隔 */
const POLL_INTERVAL_MS = 60 * 1000;
/** 失败退避上限（8 分钟） */
const MAX_BACKOFF_MS = 8 * 60 * 1000;
/** 定时任务检查间隔 */
const TICK_INTERVAL_MS = 60 * 1000;
/** announcedApprovals 最多保留的 ID 数（防止 json 无限增长） */
const ANNOUNCED_KEEP = 200;

const fmt = (n: number | string | null | undefined): string => {
  const num = Number(n ?? 0);
  return isNaN(num) ? '0.00' : num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

function loadState(): BroadcastState {
  return read<BroadcastState>(STATE_FILE, {});
}

function saveState(state: BroadcastState): void {
  write(STATE_FILE, state);
}

/* ==================== 待审批轮询 ==================== */

let failStreak = 0;
let nextAttemptAt = 0;
let sentFirstFailureLog = false;

/** 待审批推送文案 */
export function approvalBroadcastText(list: any[]): string {
  const lines = [`【新的待审批支付 ${list.length} 笔】`];
  for (const a of list.slice(0, 5)) {
    lines.push(`${fmt(a.amount)} 点｜${a.payerName || '—'} → ${a.payeeName || '—'}${a.note ? `｜${a.note}` : ''}`);
    lines.push(`　通过： #通过 ${a.id}　驳回： #驳回 ${a.id}`);
  }
  if (list.length > 5) lines.push(`…另有 ${list.length - 5} 笔，发送 #审批 查看全部。`);
  lines.push('审批按绑定账号的官网权限判定，非管理员会被拒绝。');
  return lines.join('\n');
}

/**
 * 轮询一次待审批列表，把「新增」的推送到管理员群。
 * @returns 本次新播报的条数（干跑用于断言；失败返回 0）
 */
export async function pollPendingApprovals(sender: GroupSender): Promise<number> {
  if (Date.now() < nextAttemptAt) return 0;

  const r = await api.payPendingApprovals();
  if (!r.ok || !r.data) {
    failStreak = Math.min(failStreak + 1, 10);
    const backoff = Math.min(POLL_INTERVAL_MS * 2 ** failStreak, MAX_BACKOFF_MS);
    nextAttemptAt = Date.now() + backoff;
    if (!sentFirstFailureLog) {
      sentFirstFailureLog = true;
      console.error(`[pay] 待审批轮询失败（${r.error || '未知错误'}），进入静默退避 ${Math.round(backoff / 1000)}s`);
    }
    return 0;
  }
  if (failStreak > 0) {
    console.log('[pay] 待审批轮询已恢复');
    failStreak = 0;
    sentFirstFailureLog = false;
  }
  nextAttemptAt = 0;

  const list: any[] = Array.isArray(r.data.approvals) ? r.data.approvals : [];
  const state = loadState();
  const announced = new Set(state.announcedApprovals || []);
  const fresh = list.filter((a) => a && a.id !== undefined && !announced.has(String(a.id)));

  if (fresh.length === 0) return 0;

  // 游标只增不减：宁可 json 稍大（另有 ANNOUNCED_KEEP 上限兜底），也不要在某笔审批暂时离开
  // 列表时把 ID 忘掉 —— 否则列表抖动或重启后会把同一笔审批二次播报给群里。
  state.announcedApprovals = [...(state.announcedApprovals || []), ...fresh.map((a) => String(a.id))].slice(-ANNOUNCED_KEEP);
  saveState(state);

  const groupId = approvalGroup();
  if (!groupId) {
    console.log(`[pay] 有 ${fresh.length} 笔新待审批，但未配置 APPROVAL_GROUP_ID/BROADCAST_GROUP_ID，仅记录日志`);
    return 0;
  }

  try {
    await sender(Number(groupId), [Structs.text(approvalBroadcastText(fresh))]);
    console.log(`[pay] 已向管理员群播报 ${fresh.length} 笔待审批`);
    return fresh.length;
  } catch (e) {
    console.error('[pay] 待审批播报发送失败:', (e as Error).message || e);
    return 0;
  }
}

/* ==================== 月报（财务对账海报） ==================== */

export interface SummaryBroadcast {
  /** 签名临时海报图地址（取不到时为 undefined，调用方回退文字链接） */
  imageUrl?: string;
  caption: string;
  /** 回退链接（管理后台对账页） */
  fallbackUrl: string;
}

/**
 * 组装月报内容：签名海报图 + 一句文字概述。
 * 概述里的「待审批 N 笔」来自 pending-approvals；今日/累计金额官网当前契约未提供，自动省略。
 */
export async function buildSummaryBroadcast(): Promise<SummaryBroadcast> {
  const fallbackUrl = `${config.officialSiteBase}/admin#pay`;
  const parts = ['【财务月报】'];

  const pending = await api.payPendingApprovals();
  if (pending.ok && pending.data) {
    const list: any[] = Array.isArray(pending.data.approvals) ? pending.data.approvals : [];
    const sum = list.reduce((s, a) => s + (Number(a.amount) || 0), 0);
    parts.push(list.length ? `待审批 ${list.length} 笔（合计 ${fmt(sum)} 点）` : '当前无待审批');
    const t = pending.data.thresholds;
    if (t) parts.push(`阈值：单笔 ${fmt(t.single)} / 日累计 ${fmt(t.daily)} / 超 ${fmt(t.approval)} 需审批`);
  } else {
    parts.push('待审批数据暂不可用');
  }

  const rendered = await api.payRenderUrl('summary');
  let imageUrl: string | undefined;
  if (rendered.ok && rendered.data?.url) {
    imageUrl = String(rendered.data.url);
    const mins = Math.max(1, Math.round((Number(rendered.data.expiresIn) || 600) / 60));
    // 今日 / 近 7 天 / 累计 / 待审批等明细由官网画在海报里（机器人的 bot-token 接口只暴露待审批与阈值）
    parts.push(`海报图为签名链接，${mins} 分钟内有效（今日 / 近 7 天 / 累计 / 待审批明细见图）。`);
  } else {
    parts.push(`海报图暂不可用：${rendered.error || '官网服务不可用'}，明细请打开对账后台。`);
  }
  parts.push(`对账后台：${fallbackUrl}`);

  return { imageUrl, caption: parts.join('\n'), fallbackUrl };
}

/* ==================== 周报（纯文字） ==================== */

/**
 * 组装文字周报：本地群活跃 Top（7 天汇总）+ 官网贡献榜 Top5。
 * @param groupId 统计活跃用的群号
 */
export async function buildWeeklyReport(groupId: string): Promise<string> {
  const lines = ['【本周群周报】'];

  const actives = groupId ? activityRangeRanking(groupId, 7, 5) : [];
  if (actives.length) {
    lines.push('群活跃 Top5：');
    actives.forEach((a, i) => {
      lines.push(`${i + 1}. ${a.name || a.qq}（${a.qq}）— ${a.count} 条 / ${a.days} 天`);
    });
  } else {
    lines.push('群活跃：本周暂无发言记录。');
  }

  const ranking = await api.contributionRanking(5);
  if (ranking.length) {
    lines.push('贡献点 Top5：');
    ranking.forEach((u: any, i: number) => {
      lines.push(`${i + 1}. ${u.nickname || u.username || u.user_id || '—'} — ${fmt(u.contribution)} 点`);
    });
  }

  lines.push(`统计范围：最近 7 天（截至 ${shanghaiNow().dateKey}）。`);
  return lines.join('\n');
}

/* ==================== 调度 ==================== */

const JOBS: ScheduledJob[] = [
  // 每月 1 日 10:00（上海）→ 财务月报海报
  { name: '月报', hour: 10, minute: 0, dayOfMonth: 1, windowMinutes: 30 },
  // 每周一 09:00（上海）→ 文字周报
  { name: '周报', hour: 9, minute: 0, weekday: 1, windowMinutes: 30 },
];

/** 向群发送「海报图 + 说明」，失败回退纯文字 */
async function sendPoster(sender: GroupSender, groupId: number, b: SummaryBroadcast): Promise<void> {
  if (b.imageUrl) {
    try {
      await sender(groupId, [Structs.image(b.imageUrl), Structs.text(`\n${b.caption}`)]);
      return;
    } catch (e) {
      console.error('[pay] 海报图发送失败，回退文字:', (e as Error).message || e);
    }
  }
  await sender(groupId, [Structs.text(`${b.caption}\n（海报图暂不可用）`)]);
}

/** 执行一次月报播报（手动 #月报 与定时任务共用内容组装） */
export async function runMonthlySummary(sender: GroupSender, groupId?: number): Promise<boolean> {
  const target = groupId ?? Number(broadcastGroup() || 0);
  if (!target) {
    console.log('[pay] 未配置 BROADCAST_GROUP_ID，跳过月报播报');
    return false;
  }
  try {
    const b = await buildSummaryBroadcast();
    await sendPoster(sender, target, b);
    return true;
  } catch (e) {
    console.error('[pay] 月报播报失败:', (e as Error).message || e);
    return false;
  }
}

/** 执行一次文字周报 */
export async function runWeeklyReport(sender: GroupSender, groupId?: string): Promise<boolean> {
  const target = groupId || broadcastGroup();
  if (!target) {
    console.log('[pay] 未配置 BROADCAST_GROUP_ID，跳过周报播报');
    return false;
  }
  try {
    const text = await buildWeeklyReport(target);
    await sender(Number(target), [Structs.text(text)]);
    return true;
  } catch (e) {
    console.error('[pay] 周报播报失败:', (e as Error).message || e);
    return false;
  }
}

/** 检查定时任务是否到点（每 60 秒调一次） */
export async function tickScheduledJobs(sender: GroupSender, now: number = Date.now()): Promise<void> {
  const sh = shanghaiNow(now);
  const state = loadState();
  state.fired = state.fired || {};
  for (const job of JOBS) {
    if (!isDue(job, sh)) continue;
    const key = jobKey(job, sh);
    if (state.fired[job.name] === key) continue;
    // 先记录再执行：极端情况下宁可漏发一次，也不要重复播报
    state.fired[job.name] = key;
    saveState(state);
    console.log(`[pay] 定时任务触发：${job.name}（${key}）`);
    if (job.name === '月报') await runMonthlySummary(sender);
    else await runWeeklyReport(sender);
  }
}

/**
 * 启动播报（仅在 PAY_BROADCAST=on 时生效）。
 * 返回 stop 函数，便于测试或优雅退出时清理定时器。
 */
export function startPayBroadcasts(sender: GroupSender): () => void {
  if (!config.payBroadcast) {
    console.log('[pay] PAY_BROADCAST 未开启，跳过待审批轮询与定时播报');
    return () => {};
  }
  console.log(
    `[pay] 播报已启用：待审批轮询 ${POLL_INTERVAL_MS / 1000}s；播报群=${broadcastGroup() || '(未配置)'}；待审批群=${approvalGroup() || '(未配置)'}`,
  );

  // 启动 5 秒后先跑一次，避免刚好错过一笔待审批
  const kickoff = setTimeout(() => {
    pollPendingApprovals(sender).catch((e) => console.error('[pay] 待审批轮询异常:', e));
  }, 5000);

  const pollTimer = setInterval(() => {
    pollPendingApprovals(sender).catch((e) => console.error('[pay] 待审批轮询异常:', e));
  }, POLL_INTERVAL_MS);

  const jobTimer = setInterval(() => {
    tickScheduledJobs(sender).catch((e) => console.error('[pay] 定时任务异常:', e));
  }, TICK_INTERVAL_MS);

  // 不阻止进程退出（index.ts 另有心跳保持存活）
  kickoff.unref?.();
  pollTimer.unref?.();
  jobTimer.unref?.();

  return () => {
    clearTimeout(kickoff);
    clearInterval(pollTimer);
    clearInterval(jobTimer);
  };
}
