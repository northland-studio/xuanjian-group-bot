/**
 * 指令帮助图（#help 图片输出）
 *
 * 流程：getCommands() 取全部指令与别名 → 本地按功能分组 → POST 官网 /api/qqbot/pay/help-card
 *      → 把官网渲染好的 png **下载到本地** data/help-cards/<hash>.png → 之后 #help 发本地图（base64:// 内联，
 *        不必让 NapCat 再去官网拉图）；下载失败则退回发在线地址，官网全挂时由调用方回退文字列表。
 *
 * 分组是「规则匹配」而不是硬编码指令清单：新增指令只要名字/描述命中规则就会自动归组，
 * 没有命中的落到「其它指令」。规则顺序固定 → 分组结果稳定（同样的指令清单必然得到同一张图，
 * 官网按内容算 hash，命中缓存时不会重复渲染）。
 *
 * 缓存两级：
 *   1) data/help-card.json —— 指令清单签名 + 图片地址/hash（清单没变且图片没过期就不请求官网）；
 *   2) data/help-cards/<hash>.png —— 图片本体，本地文件在就以 base64:// 内联发送。
 * `#help 刷新` 会跳过缓存重新生成（重新 POST + 重新下载）。
 */
import fs from 'fs';
import path from 'path';
import { getCommands } from '../core/command.js';
import * as api from './officialApi.js';
import { read, write, dataDir } from './store.js';

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

/** 图片本体目录（data/help-cards/），文件名 = 官网按内容算的 hash */
const IMAGE_SUBDIR = 'help-cards';
/** 本地最多保留几张历史图（hash 变了就写新文件，旧的清掉，避免越堆越多） */
const IMAGE_KEEP = 5;
/** 下载超时：官网首次渲染可能要一两秒，超时就直接发在线地址 */
const DOWNLOAD_TIMEOUT_MS = 20000;

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

/* ==================== 图片本体（发本地文件才不依赖官网在线） ==================== */

/** 图片文件名：优先用官网内容 hash，缺 hash 时退化成 url 文件名；只留安全字符防路径穿越 */
function imageKey(hash: string | undefined, url: string): string {
  let fromUrl = '';
  try {
    fromUrl = path.basename(new URL(url).pathname).replace(/\.png$/i, '');
  } catch {
    fromUrl = '';
  }
  const raw = String(hash || fromUrl || 'help').replace(/[^A-Za-z0-9._-]/g, '');
  return raw || 'help';
}

function imageDirPath(): string {
  return path.join(dataDir(), IMAGE_SUBDIR);
}

function imagePathOf(key: string): string {
  return path.join(imageDirPath(), `${key}.png`);
}

/** 本地图可用性：存在且 >8 字节（PNG magic 就是 8 字节，小于它必然是坏文件） */
function localImageOk(file: string | null | undefined): file is string {
  try {
    return !!file && fs.statSync(file).size > 8;
  } catch {
    return false;
  }
}

/** 只保留最近 IMAGE_KEEP 张历史图（含当前这张） */
function pruneImages(keepFile: string): void {
  try {
    const dir = imageDirPath();
    const others = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.png'))
      .map((f) => path.join(dir, f))
      .filter((f) => f !== keepFile)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const f of others.slice(Math.max(0, IMAGE_KEEP - 1))) fs.unlinkSync(f);
  } catch {
    /* 清理失败不影响发图 */
  }
}

/**
 * 确保本地有这张图：命中就复用，没有就下载一次（原子写：先写 .tmp 再 rename）。
 * 任何失败都返回 null —— 调用方会退回「发在线地址」，不影响出图。
 */
async function ensureLocalImage(url: string, hash?: string, cachedPath?: string | null): Promise<string | null> {
  if (localImageOk(cachedPath)) return cachedPath;

  const dest = imagePathOf(imageKey(hash, url));
  if (localImageOk(dest)) return dest;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // magic 校验：别把官网的错误页/HTML 当图片存进本地缓存
    const isPng = buf.length > 100 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (!isPng) throw new Error(`不是有效 PNG（${buf.length} 字节）`);

    fs.mkdirSync(imageDirPath(), { recursive: true });
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    pruneImages(dest);
    console.log(`[help] 帮助图已下载到本地：${dest}（${(buf.length / 1024).toFixed(1)}KB）`);
    return dest;
  } catch (e) {
    console.error('[help] 帮助图本地缓存失败，改发在线地址:', (e as Error)?.message || e);
    return null;
  }
}

/** 当前本地帮助图路径（存在时返回；运维/脚本排查用） */
export function localHelpImagePath(): string | null {
  const c = memory || loadCache();
  return c && localImageOk(c.localPath) ? c.localPath : null;
}

/**
 * 把本地帮助图转成 OneBot 通用的内联图片：`base64://<数据>`。
 *
 * 为什么不直接发 `file://` 路径：NapCat 的 `file://` 是「内部文件哈希 ID」（如 file://1234567890），
 * 不是文件系统路径 —— 发 `file:///var/www/...png` 只会查找失败；而绝对路径直接发又依赖
 * NapCat 的 enableLocalFile2Url（本机为 false）。`base64://` 是 NapCat 明确支持的资源规范，
 * 与配置无关，代价是每张图多 ~33% 体积（帮助图约 340KB → 460KB，发图频率很低，可接受）。
 */
export function localImageAsBase64Uri(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length <= 8 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
    return `base64://${buf.toString('base64')}`;
  } catch (e) {
    console.error('[help] 读取本地帮助图失败（改发在线地址）:', (e as Error)?.message || e);
    return null;
  }
}

/* ==================== 缓存 ==================== */

interface HelpCardCache {
  /** 指令清单签名（清单变了就重新生成） */
  signature: string;
  url: string;
  hash?: string;
  /** 本地图片绝对路径（null = 当时没下载成功） */
  localPath?: string | null;
  count: number;
  /** 过期时间戳；null = 官网没给有效期（永久） */
  expiresAt: number | null;
  savedAt: string;
}

export interface HelpCardResult {
  ok: boolean;
  /** 图片地址（公开只读，作为本地文件不可用时的兜底） */
  url?: string;
  hash?: string;
  /** 本地图片绝对路径（已下载成功时才返回；调用方优先发这个） */
  localPath?: string;
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

/** 命中缓存时的统一出口：顺手确保本地有图（首次升级/本地被删都会自动补下） */
async function resultFromCache(cached: HelpCardCache, extra: Partial<HelpCardResult> = {}): Promise<HelpCardResult> {
  const localPath = await ensureLocalImage(cached.url, cached.hash, cached.localPath);
  if (localPath !== cached.localPath) {
    cached.localPath = localPath;
    write(CACHE_FILE, cached);
  }
  return {
    ok: true,
    url: cached.url,
    hash: cached.hash,
    count: cached.count,
    cached: true,
    localPath: localPath || undefined,
    ...extra,
  };
}

/**
 * 取帮助图（本地文件优先，在线地址兜底）。
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
      return resultFromCache(cached);
    }
  }

  const r = await api.postHelpCard(payload);
  const url = r.data?.url ? String(r.data.url) : '';
  if (!r.ok || !url) {
    // 官网挂了也别把能用的旧图丢掉：先回旧图，实在没有才让调用方回退文字列表
    const cached = memory || loadCache();
    if (usable(cached, signature)) {
      memory = cached;
      return resultFromCache(cached, { stale: true });
    }
    return { ok: false, count, error: r.error || '官网服务不可用，请稍后再试' };
  }

  const expiresIn = Number(r.data?.expiresIn);
  const entry: HelpCardCache = {
    signature,
    url,
    hash: r.data?.hash ? String(r.data.hash) : undefined,
    localPath: null,
    count: Number(r.data?.count) || count,
    // 官网给秒数时提前 5 秒失效，避免发出刚好过期的签名图；null/0 视为永久
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 - 5000 : null,
    savedAt: new Date().toISOString(),
  };
  // 生成成功就把图片本体一起落到本地：之后 #help 直接发本地文件，不再依赖官网在线
  entry.localPath = await ensureLocalImage(entry.url, entry.hash);
  memory = entry;
  write(CACHE_FILE, entry);
  return {
    ok: true,
    url: entry.url,
    hash: entry.hash,
    count: entry.count,
    cached: false,
    localPath: entry.localPath || undefined,
  };
}

/** 清空帮助图缓存（干跑/排查用） */
export function clearHelpCardCache(): void {
  memory = null;
}
