/**
 * 官网 API 客户端（只读查询）
 * 通过官网开放接口读取档案 / 处分 / 排行榜等数据。
 * 机器人不直连官网数据库，统一走 HTTP。
 */
import { config } from '../config.js';

/** 通用请求：GET 官网接口，返回 JSON；失败返回 null */
async function get<T = any>(path: string): Promise<T | null> {
  try {
    const headers: Record<string, string> = {};
    if (config.officialBotToken) headers['X-Bot-Token'] = config.officialBotToken;
    const resp = await fetch(`${config.officialApiBase}${path}`, { headers });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch (e) {
    return null;
  }
}

/** 查询成员档案（GMIRS 单档案） */
export async function queryArchive(idOrName: string) {
  // 优先按数字 ID 查档案
  if (/^\d+$/.test(idOrName)) {
    const d = await get(`/api/gmirs/user/${idOrName}`);
    if (d && (d as any).archive) return (d as any).archive;
  }
  // 否则模糊查询取第一个
  const q = await get<any>(`/api/gmirs/query?keyword=${encodeURIComponent(idOrName)}`);
  if (q?.users?.length) {
    const uid = q.users[0].id;
    const d = await get(`/api/gmirs/user/${uid}`);
    if (d && (d as any).archive) return (d as any).archive;
  }
  return null;
}

/** 查询处分记录 */
export async function queryDiscipline(name: string) {
  const d = await get<any>(`/api/discipline/query?username=${encodeURIComponent(name)}`);
  return d?.results || [];
}

/** 贡献点排行榜 Top N */
export async function contributionRanking(limit = 10) {
  const d = await get<any>(`/api/rankings/contribution?limit=${limit}`);
  return d?.rankings || [];
}

/** 签到排行榜 Top N */
export async function checkinRanking(limit = 10) {
  const d = await get<any>(`/api/rankings/checkin?limit=${limit}`);
  return d?.rankings || [];
}

/** 在线玩家 */
export async function onlinePlayers() {
  const d = await get<any>(`/api/mod/online`);
  return d?.players || [];
}
