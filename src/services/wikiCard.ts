/**
 * Wiki 词条卡片（群聊出图）
 *
 * 流程：#wiki 关键词 → 官网 /api/wiki/search 拿列表 → 记住「群+人」的这次结果（5 分钟）
 *       → 玩家回 `#[序号]` → 下载官网渲染好的 PNG（/api/wiki/card/<slug>.png）→ base64 内联发群。
 *
 * 为什么不用机器人自己截图：官网已有 SVG→PNG 海报管线（sharp + Noto CJK，#help 卡片在用），
 * 单张约 100ms；机器人这边只负责"取图 + 发送"，不引 Chromium。
 */
import { config } from '../config.js';
import { Structs } from 'node-napcat-ts';
import type { CommandContext } from '../core/command.js';

export interface WikiHit {
  id: number;
  title: string;
  slug: string;
  summary?: string;
  snippet?: string;
  category_name?: string | null;
}

interface Session {
  items: WikiHit[];
  at: number;
}

const TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 500;
const sessions = new Map<string, Session>();

const keyOf = (groupId: string | undefined, userId: string) => `${groupId || 'private'}:${userId}`;

/** 记住这次搜索结果（同一人同一群只留最近一次） */
export function rememberHits(groupId: string | undefined, userId: string, items: WikiHit[]): void {
  if (sessions.size > MAX_SESSIONS) {
    // 简单清理：把过期的删掉，仍超量就删最早插入的
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.at > TTL_MS) sessions.delete(k);
    while (sessions.size > MAX_SESSIONS) {
      const first = sessions.keys().next().value;
      if (first === undefined) break;
      sessions.delete(first);
    }
  }
  sessions.set(keyOf(groupId, userId), { items: items.slice(0, 10), at: Date.now() });
}

/** 按序号取回词条（1 起；过期或越界返回 null） */
export function pickHit(groupId: string | undefined, userId: string, index: number): WikiHit | null {
  const s = sessions.get(keyOf(groupId, userId));
  if (!s) return null;
  if (Date.now() - s.at > TTL_MS) {
    sessions.delete(keyOf(groupId, userId));
    return null;
  }
  return s.items[index - 1] || null;
}

/** 下载官网渲染好的词条卡片，转成 OneBot 的 base64:// 内联图片 */
export async function fetchCardUri(slug: string): Promise<string | null> {
  try {
    const url = `${config.officialApiBase.replace(/\/+$/, '')}/api/wiki/card/${encodeURIComponent(slug)}.png`;
    const headers: Record<string, string> = {};
    if (config.officialBotToken) headers['X-Bot-Token'] = config.officialBotToken;
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > 6 * 1024 * 1024) return null;
    return `base64://${buf.toString('base64')}`;
  } catch (e) {
    console.error('[wiki] 取卡片失败:', (e as Error)?.message || e);
    return null;
  }
}

/** 发图（群聊发群、私聊发私聊），失败返回 false 由调用方降级 */
export async function sendCardImage(ctx: CommandContext, imageUri: string, caption: string): Promise<boolean> {
  try {
    const message = [Structs.image(imageUri), Structs.text(`\n${caption}`)];
    if (ctx.groupId) {
      await ctx.client.send('send_group_msg', { group_id: Number(ctx.groupId), message });
    } else {
      await ctx.client.send('send_private_msg', { user_id: Number(ctx.userId), message });
    }
    return true;
  } catch (e) {
    console.error('[wiki] 发卡片失败:', (e as Error)?.message || e);
    return false;
  }
}

export function cardUrlOf(slug: string): string {
  return `${config.officialSiteBase}/wiki/${slug}`;
}
