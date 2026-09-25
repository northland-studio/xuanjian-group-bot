/**
 * 配置读取（基于 .env）
 */
import 'dotenv/config';

function list(key: string): string[] {
  return (process.env[key] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  /** NapCat 连接 */
  napcat: {
    baseUrl: process.env.NAPCAT_BASE_URL || undefined,
    protocol: (process.env.NAPCAT_PROTOCOL || 'ws') as 'ws' | 'wss',
    host: process.env.NAPCAT_HOST || '127.0.0.1',
    port: parseInt(process.env.NAPCAT_PORT || '3001', 10),
    token: process.env.NAPCAT_TOKEN || undefined,
  },
  /** 允许的群 */
  allowedGroups: list('ALLOWED_GROUPS'),
  /** 管理员 QQ */
  adminQQ: list('ADMIN_QQ'),
  /** 官网 */
  officialApiBase: process.env.OFFICIAL_API_BASE || 'https://xuanjian.top',
  officialBotToken: process.env.OFFICIAL_BOT_TOKEN || '',
  /** 官网站点根地址（用于生成可扫码的支付链接与二维码图片地址） */
  officialSiteBase: (process.env.OFFICIAL_SITE_BASE || process.env.OFFICIAL_API_BASE || 'https://xuanjian.top').replace(/\/+$/, ''),
  /** 支付播报总开关：只有 PAY_BROADCAST=on 时才启用待审批轮询与定时播报（缺省 off） */
  payBroadcast: (process.env.PAY_BROADCAST || '').trim().toLowerCase() === 'on',
  /**
   * 播报目标群（财务月报图 + 文字周报都发这里）
   * 默认主群 860336849；可用 BROADCAST_GROUP_ID 覆盖。
   */
  broadcastGroupId: (process.env.BROADCAST_GROUP_ID || '860336849').trim(),
  /**
   * 待审批推送群：默认与播报群一致；可用 APPROVAL_GROUP_ID 单独指定（例如只推给管理群）。
   * 兼容旧变量 ADMIN_GROUP_ID 作为兜底。
   */
  approvalGroupId: (
    process.env.APPROVAL_GROUP_ID ||
    process.env.BROADCAST_GROUP_ID ||
    '860336849'
  ).trim(),
};

/** 播报群号（数字字符串；配置非法时返回空串，调用方只记日志不发送） */
export function broadcastGroup(): string {
  return /^\d+$/.test(config.broadcastGroupId) ? config.broadcastGroupId : '';
}

/** 待审批推送群号（APPROVAL_GROUP_ID > BROADCAST_GROUP_ID > ADMIN_GROUP_ID > 默认主群） */
export function approvalGroup(): string {
  const candidate = config.approvalGroupId || (process.env.ADMIN_GROUP_ID || '').trim();
  return /^\d+$/.test(candidate) ? candidate : '';
}

/** 判断某群是否在允许列表（若未配置则放行全部） */
export function isAllowedGroup(groupId: string | number): boolean {
  const g = String(groupId);
  return config.allowedGroups.length === 0 || config.allowedGroups.includes(g);
}

/** 判断某 QQ 是否为管理员 */
export function isAdmin(qq: string | number): boolean {
  const q = String(qq);
  return config.adminQQ.includes(q);
}
