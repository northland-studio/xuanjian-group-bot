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
};

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
