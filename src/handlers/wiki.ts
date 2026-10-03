/**
 * Wiki 指令
 *
 *   #wiki 关键词     → 搜索已发布词条，回编号列表，并记住这次结果（5 分钟）
 *   #[序号] / #序号  → 出该词条的卡片图（官网渲染），失败退化为"摘要 + 链接"
 *
 * 序号是「兜底指令」：不注册成具名指令，所以不会出现在 #help 列表里。
 */
import { registerCommand, setFallbackHandler } from '../core/command.js';
import type { CommandContext } from '../core/command.js';
import { config } from '../config.js';
import * as api from '../services/officialApi.js';
import { rememberHits, pickHit, fetchCardUri, sendCardImage, cardUrlOf } from '../services/wikiCard.js';
import type { WikiHit } from '../services/wikiCard.js';

const LIST_MAX = 6;

function summarize(s: string | undefined, len: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（暂无摘要）';
  return t.length > len ? t.slice(0, len - 1) + '…' : t;
}

export function registerWikiCommands(): void {
  registerCommand('wiki', ['维基', '词条', 'wiki搜索'], '搜索 Wiki 词条：#wiki 关键词（回编号列表，#[序号] 出图）', async (ctx: CommandContext) => {
    const q = ctx.text.trim();
    if (!q) {
      return ctx.reply(
        [
          '用法：#wiki <关键词>',
          '例如：#wiki 红石比较器　#wiki 刷石机',
          `然后回复 #[序号] 出词条卡片图；完整内容：${config.officialSiteBase}/wiki`
        ].join('\n')
      );
    }

    const res = await api.searchWiki(q, LIST_MAX);
    // 官网 /api/wiki/search 返回的是 { ok, pages: [...], total, ... }（数组字段叫 pages，不是 items）
    const items: WikiHit[] = Array.isArray(res?.pages) ? (res.pages as WikiHit[]) : [];
    if (!items.length) {
      return ctx.reply(
        `没有找到与「${q}」相关的词条。\n可以换个关键词（如"红石""刷怪塔""村民"），或到官网搜索：${config.officialSiteBase}/wiki/search?q=${encodeURIComponent(q)}`
      );
    }

    rememberHits(ctx.groupId, ctx.userId, items);
    const lines = [`「${q}」相关词条（共 ${res?.total ?? items.length} 条，回复 #[序号] 出图）：`];
    items.forEach((it, i) => {
      const cat = it.category_name ? `［${it.category_name}］` : '';
      lines.push(`[${i + 1}] ${cat}${it.title}`);
      lines.push(`     ${summarize(it.summary || it.snippet, 46)}`);
    });
    lines.push('序号 5 分钟内有效；也可以直接看网页版。');
    ctx.reply(lines.join('\n'));
  });

  // 兜底：把 `#[3]` / `#3` 当成"选第 3 条"（仅当没有同名具名指令时才会走到这里）
  setFallbackHandler(async (ctx: CommandContext) => {
    const index = Number(String(ctx.text).trim());
    if (!Number.isFinite(index) || index < 1) return;

    const hit = pickHit(ctx.groupId, ctx.userId, index);
    if (!hit) {
      return ctx.reply('序号已失效（超过 5 分钟或没搜过），请重新 #wiki 搜索。');
    }

    const uri = await fetchCardUri(hit.slug);
    if (uri && (await sendCardImage(ctx, uri, `${hit.title} · 玄剑 Wiki　${cardUrlOf(hit.slug)}`))) return;

    // 出图失败（官网异常/图太大）→ 文字摘要 + 链接兜底，不能让玩家干等
    ctx.reply(
      [`【${hit.title}】`, summarize(hit.summary, 120), `完整内容：${cardUrlOf(hit.slug)}`].join('\n')
    );
  });
}
