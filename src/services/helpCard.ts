/**
 * 指令帮助图（#help 图片输出）
 *
 * 流程：getCommands() 取全部指令与别名 → 本地按功能分组 → POST 官网 /api/qqbot/help-card
 *      → 拿公开只读的 png 地址发图；官网不可用时由调用方回退文字列表。
 *
 * 分组是「规则匹配」而不是硬编码指令清单：新增指令只要名字/描述命中规则就会自动归组，
 * 没有命中的落到「其它指令」。规则顺序固定 → 分组结果稳定（同样的指令清单必然得到同一张图，
 * 官网按内容算 hash，命中缓存时不会重复渲染）。
 *
 * 缓存：进程内 + data/help-card.json（含指令清单签名）。指令清单没变且图片没过期就直接复用；
 * `#help 刷新` 会跳过缓存重新生成。
 */
import { getCommands } from '../core/command.js';
import * as api from './officialApi.js';
import { read, write } from './store.js';

/** 帮助图标题（官网按它画头部） */
export const HELP_CARD_TITLE = '玄剑公会群机器人 · 指令总览';
/** 前缀提示（#help 与 /help 都支持） */
export const HELP_CARD_PREFIX = '前缀 # 或 /';

/** 官网契约上限（超限会被 400 拒绝，这里提前收口） */
const MAX_GROUPS = 12;
const MAX_ITEMS_PER_GROUP = 40;
const MAX_NAME = 12;
const MAX_DESC = 40;

/** 缓存文件（存 data/help-card.json） */
const CACHE_FILE = 'help-card';

export interface HelpCardItem {
  name: string;
  aliases: string[];
  desc: string;
}

export interface HelpCardGroup {
  name: string;
  items: HelpCardItem[];
}

/**
 * 功能分组规则（按顺序匹配，先命中先归组）。
 * 先看「指令名 + 别名」，不命中再看描述，都不命中落到 FALLBACK_GROUP。
 * 分组的顺序 = 规则顺序，保证稳定可读。
 */
const GROUP_RULES: Array<{ name: string; re: RegExp }> = [
  { name: '帮助与菜单', re: /help|帮助|菜单|指令图|指令列表/ },
  { name: '成员与档案', re: /档案|处分|绑定|查自己|名片|成员/ },
  { name: '排行与状态', re: /排行|在线|活跃|服务器|状态/ },
  { name: '官网资讯', re: /日报|决策|公告|资讯|帖子/ },
  { name: '娱乐互动', re: /运势|抽签|掷骰|骰|娱乐/ },
  { name: '核销与任务', re: /核销|任务/ },
  { name: '支付与缴费', re: /收款|付款|缴费|转分|支付|审批|通过|驳回|月报|财务/ },
  { name: '群管理', re: /禁言|解禁|踢人|移出|迎新|欢迎|管理/ },
];

/** 未命中任何规则的指令归到这里（永远排在最后） */
export const FALLBACK_GROUP = '其它指令';

/** 按字数截断（默认省略号占 1 字） */
function cut(s: unknown, max: number): string {
  const str = String(s ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(str);
  if (chars.length <= max) return str;
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/** 命中规则（名称为主、描述兜底） */
function ruleOf(name: string, aliases: string[], desc: string): string {
  const nameHay = `${name} ${aliases.join(' ')}`;
  const hit = GROUP_RULES.find((r) => r.re.test(nameHay)) || GROUP_RULES.find((r) => r.re.test(desc));
  return hit ? hit.name : FALLBACK_GROUP;
}

/**
 * 从指令注册表生成官网请求体的 groups。
 * 不含硬编码指令清单：全部来自 getCommands()。
 */
export function buildHelpCardGroups(): HelpCardGroup[] {
  const buckets = new Map<string, HelpCardItem[]>();
  for (const rule of GROUP_RULES) buckets.set(rule.name, []);
  buckets.set(FALLBACK_GROUP, []);

  for (const c of getCommands()) {
    const aliases = (c.aliases || []).map((a) => cut(a, MAX_NAME)).filter(Boolean);
    const key = ruleOf(String(c.name), aliases, String(c.desc || ''));
    const list = buckets.get(key) || buckets.get(FALLBACK_GROUP)!;
    list.push({
      name: cut(c.name, MAX_NAME),
      aliases,
      desc: cut(c.desc, MAX_DESC),
    });
  }

  // 空组不进图；超过 12 组时把尾部合并进「其它指令」，保证不触发官网 400
  let groups: HelpCardGroup[] = [...buckets.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([name, items]) => ({ name, items }));

  if (groups.length > MAX_GROUPS) {
    const keep = groups.slice(0, MAX_GROUPS - 1);
    const merged = groups.slice(MAX_GROUPS - 1).flatMap((g) => g.items);
    groups = [...keep, { name: FALLBACK_GROUP, items: merged }];
  }

  // 每组不超过 40 条：溢出的挪到「其它指令」，再超就丢弃（只可能出现在异常庞大的注册表上）
  const overflow: HelpCardItem[] = [];
  for (const g of groups) {
    if (g.items.length > MAX_ITEMS_PER_GROUP) {
      overflow.push(...g.items.slice(MAX_ITEMS_PER_GROUP));
      g.items = g.items.slice(0, MAX_ITEMS_PER_GROUP);
    }
  }
  if (overflow.length) {
    const other = groups.find((g) => g.name === FALLBACK_GROUP);
    if (other) {
      other.items = [...other.items, ...overflow].slice(0, MAX_ITEMS_PER_GROUP);
    } else if (groups.length < MAX_GROUPS) {
      groups.push({ name: FALLBACK_GROUP, items: overflow.slice(0, MAX_ITEMS_PER_GROUP) });
    } else {
      console.error(`[help] 指令过多，${overflow.length} 条未进帮助图`);
    }
  }

  return groups;
}

/** 指令总数（帮助图的 subtitle 与发图文案都用它） */
export function helpCardCommandCount(): number {
  return getCommands().length;
}

/** 官网请求体（title/subtitle/groups） */
export function buildHelpCardPayload(): api.HelpCardPayload {
  const count = helpCardCommandCount();
  return {
    title: HELP_CARD_TITLE,
    subtitle: `共 ${count} 条指令 · ${HELP_CARD_PREFIX}`,
    groups: buildHelpCardGroups(),
  };
}

/** 发图时配的短文案 */
export function helpCardCaption(count: number): string {
  return `共 ${count} 条指令，${HELP_CARD_PREFIX}（发送 #help 刷新 可重新生成）`;
}

/* ==================== 缓存 ==================== */

interface HelpCardCache {
  /** 指令清单签名（清单变了就重新生成） */
  signature: string;
  url: string;
  hash?: string;
  count: number;
  /** 过期时间戳；null = 官网没给有效期（永久） */
  expiresAt: number | null;
  savedAt: string;
}

export interface HelpCardResult {
  ok: boolean;
  /** 图片地址（公开只读） */
  url?: string;
  hash?: string;
  /** 官网返回的指令条数（缺省用本地条数） */
  count: number;
  /** 是否直接用了缓存（没有请求官网） */
  cached?: boolean;
  /** 刷新失败但旧图仍可用 */
  stale?: boolean;
  error?: string;
}

let memory: HelpCardCache | null = null;

function usable(c: HelpCardCache | null, signature: string): c is HelpCardCache {
  if (!c || !c.url || c.signature !== signature) return false;
  if (c.expiresAt && Date.now() >= c.expiresAt) return false;
  return true;
}

/** 读磁盘缓存（容错：文件损坏/字段缺失都当作没有缓存） */
function loadCache(): HelpCardCache | null {
  const c = read<HelpCardCache | null>(CACHE_FILE, null);
  if (!c || typeof c !== 'object' || !c.url || !c.signature) return null;
  return c;
}

/**
 * 取帮助图地址。
 * @param force 跳过缓存强制重新生成（`#help 刷新`）
 */
export async function getHelpCard(force = false): Promise<HelpCardResult> {
  const payload = buildHelpCardPayload();
  const signature = JSON.stringify(payload);
  const count = helpCardCommandCount();

  if (!force) {
    const cached = usable(memory, signature) ? memory : loadCache();
    if (usable(cached, signature)) {
      memory = cached;
      return { ok: true, url: cached.url, hash: cached.hash, count: cached.count, cached: true };
    }
  }

  const r = await api.postHelpCard(payload);
  const url = r.data?.url ? String(r.data.url) : '';
  if (!r.ok || !url) {
    // 官网挂了也别把能用的旧图丢掉：先回旧图，实在没有才让调用方回退文字列表
    const cached = memory || loadCache();
    if (usable(cached, signature)) {
      memory = cached;
      return { ok: true, url: cached.url, hash: cached.hash, count: cached.count, cached: true, stale: true };
    }
    return { ok: false, count, error: r.error || '官网服务不可用，请稍后再试' };
  }

  const expiresIn = Number(r.data?.expiresIn);
  const entry: HelpCardCache = {
    signature,
    url,
    hash: r.data?.hash ? String(r.data.hash) : undefined,
    count: Number(r.data?.count) || count,
    // 官网给秒数时提前 5 秒失效，避免发出刚好过期的签名图；null/0 视为永久
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 - 5000 : null,
    savedAt: new Date().toISOString(),
  };
  memory = entry;
  write(CACHE_FILE, entry);
  return { ok: true, url: entry.url, hash: entry.hash, count: entry.count, cached: false };
}

/** 清空帮助图缓存（干跑/排查用） */
export function clearHelpCardCache(): void {
  memory = null;
}
