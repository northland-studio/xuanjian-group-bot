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
 * 核销码验证（群内普通成员可查核销信息与状态）
 * 依赖官网 bot-token 接口 /api/qqbot/verify-code
 * 核销码绑定消费用户，持码即可查询，无需身份验证。
 * 返回 { valid, item?, already?, error? } 或 null。
 */
export async function verifyCode(code: string) {
  return post<any>(`/api/qqbot/verify-code`, { code });
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

/* ==================================================================
 * 贡献点扫码支付（机器人只出码与播报，扣款一律回网页确认 —— 决策 3，不做免密）
 * 鉴权：沿用 X-Bot-Token（与 /api/qqbot/* 完全一致）
 * 官网侧实现：routes/qqbot-pay.js（挂载 /api/qqbot/pay）
 * ================================================================== */

/** 带状态码的响应（需要把官网 4xx 的错误文案原样透传给群成员） */
export interface PayApiResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
  /** 失败原因（官网 { error } 文案 / 网络错误） */
  error?: string;
}

/** 通用请求：保留状态码与官网错误文案 */
async function requestJson<T = any>(path: string, init: RequestInit = {}): Promise<PayApiResult<T>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string> | undefined) || {}),
    };
    if (config.officialBotToken) headers['X-Bot-Token'] = config.officialBotToken;

    const resp = await fetch(`${config.officialApiBase}${path}`, { ...init, headers });
    let data: any = null;
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
    if (resp.ok) return { ok: true, status: resp.status, data: data as T };
    return {
      ok: false,
      status: resp.status,
      data: data as T,
      error: data?.error || `官网接口返回 ${resp.status}`,
    };
  } catch {
    return { ok: false, status: 0, data: null, error: '官网服务不可用，请稍后再试' };
  }
}

/** 支付二维码图片地址（官网公开只读接口，机器人直接作为图片发送即可） */
export function payQrImageUrl(text: string, size = 360): string {
  return `${config.officialSiteBase}/api/pay/qr.png?text=${encodeURIComponent(text)}&size=${size}`;
}

/**
 * 生成收款码（主扫）：代已绑定 QQ 的用户出码，90 秒有效。
 * 未绑定时 data.error 内含提示文案。
 */
export async function payReceiveCode(qq: string, amount?: number | string, note?: string) {
  return requestJson<any>(`/api/qqbot/pay/receive-code`, {
    method: 'POST',
    body: JSON.stringify({ qq, amount, note }),
  });
}

/** 生成付款码（反扫）：60 秒有效，由收款方扫码后发起，付款方仍需回网页确认 */
export async function payPayerCode(qq: string) {
  return requestJson<any>(`/api/qqbot/pay/payer-code`, {
    method: 'POST',
    body: JSON.stringify({ qq }),
  });
}

/** 查询本人支付记录（只读） */
export async function payRecords(qq: string, limit = 20) {
  return requestJson<any>(`/api/qqbot/pay/records?qq=${encodeURIComponent(qq)}&limit=${limit}`);
}

/**
 * 创建缴费单（仅管理员 / 认证成员绑定的账号；权限由官网侧统一校验）
 * targets 支持 ["123456", { qq, playerName }]
 */
export async function payCharge(
  qq: string,
  payload: {
    title: string;
    amount?: number | string;
    targets?: Array<string | { qq: string; playerName?: string }>;
    openAll?: boolean;
    deadline?: string;
    note?: string;
  },
) {
  return requestJson<any>(`/api/qqbot/pay/charge`, {
    method: 'POST',
    body: JSON.stringify({ qq, ...payload }),
  });
}
