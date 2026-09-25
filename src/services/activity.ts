/**
 * 群活跃统计
 * 记录每群每日每位成员的发言条数，支持排行查询。
 * 数据持久化到本地 JSON（data/activity.json）。
 */
import { read, write, todayStr } from './store.js';

interface DayData {
  [qq: string]: { name?: string; count: number };
}

interface ActivityData {
  [groupId: string]: {
    [date: string]: DayData;
  };
}

/** 记录一条群发言 */
export function recordActivity(groupId: string, qq: string, nickname?: string): void {
  const data = read<ActivityData>('activity', {});
  const today = todayStr();
  if (!data[groupId]) data[groupId] = {};
  if (!data[groupId][today]) data[groupId][today] = {};
  if (!data[groupId][today][qq]) data[groupId][today][qq] = { name: nickname, count: 0 };
  data[groupId][today][qq].count += 1;
  if (nickname && data[groupId][today][qq].name !== nickname) data[groupId][today][qq].name = nickname;
  write('activity', data);
}

/** 查询某群某天的活跃排行（默认今天，limit 名） */
export function activityRanking(groupId: string, limit = 10, daysBack = 0): { qq: string; name?: string; count: number }[] {
  const data = read<ActivityData>('activity', {});
  const group = data[groupId];
  if (!group) return [];
  const targetDate = todayStr(-daysBack);
  const day = group[targetDate];
  if (!day) return [];
  return Object.entries(day)
    .map(([qq, v]) => ({ qq, name: v.name, count: v.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * 汇总最近 N 天（含今天）的活跃排行，供周报使用。
 * @param days 统计天数，默认 7
 * @param limit 取前几名
 */
export function activityRangeRanking(
  groupId: string,
  days = 7,
  limit = 5,
): { qq: string; name?: string; count: number; days: number }[] {
  const data = read<ActivityData>('activity', {});
  const group = data[groupId];
  if (!group) return [];
  const total: Record<string, { name?: string; count: number; days: number }> = {};
  for (let i = 0; i < days; i++) {
    const day = group[todayStr(-i)];
    if (!day) continue;
    for (const [qq, v] of Object.entries(day)) {
      if (!total[qq]) total[qq] = { name: v.name, count: 0, days: 0 };
      total[qq].count += v.count;
      total[qq].days += 1;
      if (v.name) total[qq].name = v.name;
    }
  }
  return Object.entries(total)
    .map(([qq, v]) => ({ qq, name: v.name, count: v.count, days: v.days }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
