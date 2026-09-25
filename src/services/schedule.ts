/**
 * 定时任务的时间计算（统一按 Asia/Shanghai 墙上时间）
 *
 * 服务器时区是 UTC，而运营时间（每月 1 日 10:00、每周一 09:00）都是按国内时间说的，
 * 所以这里把「时间戳 + 8 小时」再用 getUTC* 读出来，得到的就是上海墙上时间。
 * 中国没有夏令时，固定 UTC+8 即可。
 */

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

export interface ShanghaiNow {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  /** 0=周日 … 6=周六 */
  weekday: number;
  /** YYYY-MM-DD（上海日期） */
  dateKey: string;
}

/** 取上海墙上时间 */
export function shanghaiNow(ts: number = Date.now()): ShanghaiNow {
  const t = new Date(ts + SHANGHAI_OFFSET_MS);
  const year = t.getUTCFullYear();
  const month = t.getUTCMonth() + 1;
  const day = t.getUTCDate();
  return {
    year,
    month,
    day,
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: t.getUTCDay(),
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
  };
}

export interface ScheduledJob {
  /** 任务名（用于状态键与日志） */
  name: string;
  /** 触发小时（上海时间） */
  hour: number;
  /** 触发分钟（上海时间，默认 0） */
  minute?: number;
  /** 每月第几天触发（与 weekday 互斥） */
  dayOfMonth?: number;
  /** 每周第几天触发（0=周日） */
  weekday?: number;
  /** 触发窗口（分钟），避免进程在整点前后重启导致漏发；默认 10 分钟 */
  windowMinutes?: number;
}

/** 判断某个任务此刻是否处于触发窗口内 */
export function isDue(job: ScheduledJob, now: ShanghaiNow): boolean {
  if (job.dayOfMonth !== undefined && now.day !== job.dayOfMonth) return false;
  if (job.weekday !== undefined && now.weekday !== job.weekday) return false;
  const target = job.hour * 60 + (job.minute || 0);
  const current = now.hour * 60 + now.minute;
  const window = job.windowMinutes ?? 10;
  return current >= target && current < target + window;
}

/**
 * 任务的唯一状态键：同一周期内只允许触发一次（重启也不会重复播报）。
 * - 按月任务：`月报-2026-10`
 * - 按周任务：`周报-2026-10-05`（触发当天的上海日期）
 */
export function jobKey(job: ScheduledJob, now: ShanghaiNow): string {
  if (job.dayOfMonth !== undefined) return `${job.name}-${now.year}-${pad(now.month)}`;
  if (job.weekday !== undefined) return `${job.name}-${now.dateKey}`;
  return `${job.name}-${now.dateKey}-${pad(now.hour)}:${pad(now.minute)}`;
}
