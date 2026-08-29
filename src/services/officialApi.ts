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

/** 通用请求：POST 官网接口，返回 JSON；失败返回 null */
async function post<T = any>(path: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.officialBotToken) headers['X-Bot-Token'] = config.officialBotToken;
    const resp = await fetch(`${config.officialApiBase}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as T;
  } catch (e) {
    return null;
  }
}

/**
 * 发起 QQ 绑定：生成一次性绑定码。
 * 返回 { success, code, username, nickname, expireMinutes } 或 null。
 */
export async function bindQq(qq: string, username: string) {
  return post<any>(`/api/qqbot/bind`, { qq, username });
}

/**
 * 按 QQ 查绑定用户（供 #查自己）。
 * 返回 { bound, user?: { id, username, nickname, qq } } 或 null。
 */
export async function getUserByQq(qq: string) {
  return get<any>(`/api/qqbot/user?qq=${encodeURIComponent(qq)}`);
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

/** 拉取官网帖子（type: daily 日报 / decision 决策，公开接口） */
export async function getPosts(type: string, limit = 5) {
  const d = await get<any>(`/api/posts?type=${encodeURIComponent(type)}&limit=${limit}&page=1`);
  return d?.posts || [];
}

/**
 * 核销码验证（管理员私聊操作）
 * 依赖官网 bot-token 接口 /api/qqbot/verify-code
 * 返回 { valid, item?, already?, error? } 或 null。
 */
export async function verifyCode(code: string, qq: string) {
  return post<any>(`/api/qqbot/verify-code`, { code, qq });
}

/**
 * 核销确认（管理员私聊操作）
 * 依赖官网 bot-token 接口 /api/qqbot/confirm-code
 */
export async function confirmCode(code: string, qq: string) {
  return post<any>(`/api/qqbot/confirm-code`, { code, qq });
}

/**
 * 玩家任务验证码完成（接取者私聊提交）
 * 依赖官网 bot-token 接口 /api/qqbot/task-complete
 */
export async function completePlayerTask(taskId: string, code: string, qq: string) {
  return post<any>(`/api/qqbot/task-complete`, { taskId, code, qq });
}
