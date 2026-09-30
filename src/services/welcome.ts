/**
 * 迎新词（入群欢迎）
 *
 * - 存储：data/welcome.json，每群一份配置（开关 + 是否 @ 新人 + 自定义文案）。
 *   结构形如 `{ version:1, groups:{ "<群号>": { enabled, mention, text, updatedAt, updatedBy } } }`。
 * - 文案支持模板变量：{at} {昵称} {群名} {人数} {时间} {换行}（未知变量原样保留，便于发现拼写错误）。
 * - 默认纯文本（不含任何 HTML/富文本标签），无自定义文案时用 DEFAULT_WELCOME_TEXT。
 * - 读写全部走 services/store（写失败只记日志）；取群名/人数/昵称失败时自动降级为空，绝不抛异常。
 */
import { Structs } from 'node-napcat-ts';
import type { SendMessageSegment } from 'node-napcat-ts';
import { read, write } from './store.js';
import { shanghaiNow } from './schedule.js';

/** 存储文件名（data/welcome.json） */
const STORE_FILE = 'welcome';

/** 迎新词长度上限（超出直接拒绝） */
export const MAX_WELCOME_TEXT_LENGTH = 500;

/** 群内发送消息用的最小客户端接口（index.ts 注入 NapCat 调用，干跑时注入 mock） */
export type NapcatSender = (method: string, params: Record<string, unknown>) => Promise<any>;

/** 默认迎新词：玄剑风格纯文本（{at} 在关闭 @ 时会被自动删掉） */
export const DEFAULT_WELCOME_TEXT = [
  '欢迎{at}加入玄剑公会！',
  '发送 #帮助 可以查看机器人指令，有问题直接在群里问就行～',
].join('\n');

/** 模板变量说明（查看指令里回显） */
export const WELCOME_VARIABLES = '{at} {昵称} {群名} {人数} {时间} {换行}';

export interface WelcomeConfig {
  /** 有人入群时是否发送迎新词（默认开） */
  enabled: boolean;
  /** 是否允许 {at} 变成真实 @（默认开） */
  mention: boolean;
  /** 自定义文案；未设置时用默认文案 */
  text?: string;
  updatedAt?: string;
  updatedBy?: string;
}

/** 磁盘结构：每群一份 */
interface WelcomeStore {
  version: number;
  groups: Record<string, WelcomeConfig>;
}

export interface WelcomeVars {
  qq?: string;
  nickname?: string;
  groupName?: string;
  memberCount?: number | string;
}

/* ==================== 存储（容错读写） ==================== */

function loadStore(): WelcomeStore {
  const raw = read<WelcomeStore | null>(STORE_FILE, null);
  if (!raw || typeof raw !== 'object' || typeof (raw as any).groups !== 'object' || !(raw as any).groups) {
    return { version: 1, groups: {} };
  }
  const groups: Record<string, WelcomeConfig> = {};
  for (const [gid, v] of Object.entries((raw as any).groups as Record<string, any>)) {
    if (!v || typeof v !== 'object') continue;
    groups[gid] = {
      enabled: v.enabled !== false,
      mention: v.mention !== false,
      text: typeof v.text === 'string' && v.text.trim() ? v.text : undefined,
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : undefined,
      updatedBy: v.updatedBy === undefined ? undefined : String(v.updatedBy),
    };
  }
  return { version: 1, groups };
}

function saveStore(store: WelcomeStore): void {
  write(STORE_FILE, store);
}

/** 取某群配置（缺省：开、@ 开、默认文案） */
export function getWelcomeConfig(groupId: string): WelcomeConfig {
  const store = loadStore();
  const cfg = store.groups[String(groupId)];
  return {
    enabled: cfg ? cfg.enabled !== false : true,
    mention: cfg ? cfg.mention !== false : true,
    text: cfg?.text,
    updatedAt: cfg?.updatedAt,
    updatedBy: cfg?.updatedBy,
  };
}

/** 实际使用的文案（自定义优先，否则默认） */
export function welcomeTextOf(cfg: WelcomeConfig): string {
  return cfg.text && cfg.text.trim() ? cfg.text : DEFAULT_WELCOME_TEXT;
}

function touch(store: WelcomeStore, groupId: string, patch: Partial<WelcomeConfig>, by?: string): void {
  const key = String(groupId);
  const prev = store.groups[key] || { enabled: true, mention: true };
  store.groups[key] = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: by === undefined ? prev.updatedBy : String(by),
  };
  saveStore(store);
}

export interface SetWelcomeResult {
  ok: boolean;
  /** 保存后的字数 */
  length: number;
  error?: string;
}

/** 保存本群迎新词（>500 字拒绝；空文本拒绝） */
export function setWelcomeText(groupId: string, text: string, by?: string): SetWelcomeResult {
  const raw = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // 群里不方便打真换行时可以直接写 \n（两个字符）
    .replace(/\\n/g, '\n')
    .trim();
  const length = Array.from(raw).length;
  if (!raw) return { ok: false, length: 0, error: '迎新词不能为空。用法：#迎新 设置 <文本>' };
  if (length > MAX_WELCOME_TEXT_LENGTH) {
    return {
      ok: false,
      length,
      error: `迎新词过长（${length} 字，最多 ${MAX_WELCOME_TEXT_LENGTH} 字），请精简后再试。`,
    };
  }
  const store = loadStore();
  touch(store, groupId, { text: raw }, by);
  return { ok: true, length };
}

/** 开 / 关本群迎新 */
export function setWelcomeEnabled(groupId: string, enabled: boolean, by?: string): void {
  const store = loadStore();
  touch(store, groupId, { enabled: !!enabled }, by);
}

/** 开 / 关 {at} 是否变成真实 @ */
export function setWelcomeMention(groupId: string, mention: boolean, by?: string): void {
  const store = loadStore();
  touch(store, groupId, { mention: !!mention }, by);
}

/** 清空本群自定义文案（回到默认；开关与 @ 设置保留） */
export function resetWelcomeText(groupId: string, by?: string): void {
  const store = loadStore();
  touch(store, groupId, { text: undefined }, by);
}

/* ==================== 模板渲染 ==================== */

/** 清理渲染产生的多余空格（不动换行） */
function tidy(s: string): string {
  return s
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/, '');
}

/** 上海时间 YYYY-MM-DD HH:mm */
export function welcomeTime(ts: number = Date.now()): string {
  const n = shanghaiNow(ts);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${n.dateKey} ${pad(n.hour)}:${pad(n.minute)}`;
}

/**
 * 替换除 {at} 以外的变量（{at} 由 buildWelcomeSegments 处理成 at 消息段）。
 * 未知变量原样保留。
 */
export function renderWelcomeText(template: string, vars: WelcomeVars = {}): string {
  const nickname = vars.nickname || (vars.qq ? `QQ ${vars.qq}` : '');
  const map: Record<string, string> = {
    昵称: nickname,
    群名: vars.groupName === undefined || vars.groupName === null ? '' : String(vars.groupName),
    人数: vars.memberCount === undefined || vars.memberCount === null ? '' : String(vars.memberCount),
    时间: welcomeTime(),
    换行: '\n',
  };
  return tidy(
    String(template ?? '').replace(/\{(昵称|群名|人数|时间|换行)\}/g, (_m, k: string) => map[k] ?? ''),
  );
}

export interface WelcomeMessage {
  segments: SendMessageSegment[];
  /** 纯文本形式（日志 / 干跑断言用，@ 记为 @QQ） */
  text: string;
  /** 本次是否真的 @ 了新人 */
  mentioned: boolean;
  config: WelcomeConfig;
}

/**
 * 把模板渲染成待发送的消息段：{at} 处插入真实 at 段（mention 关闭时直接删掉）。
 */
export function buildWelcomeSegments(
  template: string,
  vars: WelcomeVars = {},
  opts: { mention?: boolean } = {},
): { segments: SendMessageSegment[]; text: string; mentioned: boolean } {
  const mention = opts.mention !== false;
  const chunks = String(template ?? '').split(/\{at\}/i);
  const segments: SendMessageSegment[] = [];
  let mentioned = false;

  const pushText = (s: string) => {
    if (s) segments.push(Structs.text(s));
  };

  pushText(renderWelcomeText(chunks[0], vars));
  for (let i = 1; i < chunks.length; i++) {
    if (mention && vars.qq) {
      segments.push(Structs.at(vars.qq));
      mentioned = true;
    }
    pushText(renderWelcomeText(chunks[i], vars));
  }
  // 全部为空时至少留一条空文本段，避免发出空消息
  if (!segments.length) segments.push(Structs.text(''));

  const text = segments
    .map((s) => (s.type === 'at' ? `@${(s as any).data?.qq ?? ''}` : String((s as any).data?.text ?? '')))
    .join('');
  return { segments, text, mentioned };
}

/**
 * 组装本群迎新消息。
 * @returns null = 本群未开启迎新（此时不发任何消息）
 */
export function buildWelcomeMessage(opts: {
  groupId: string;
  userId: string;
  nickname?: string;
  groupName?: string;
  memberCount?: number | string;
  /** 测试模式：即使关闭也能发、标明「测试」、不真实 @ 新人 */
  test?: boolean;
  /** 测试模式下的临时文案（不落库） */
  textOverride?: string;
}): WelcomeMessage | null {
  const cfg = getWelcomeConfig(opts.groupId);
  if (!cfg.enabled && !opts.test) return null;

  const template = opts.textOverride && opts.textOverride.trim() ? opts.textOverride : welcomeTextOf(cfg);
  const built = buildWelcomeSegments(
    opts.test ? `【测试】\n${template}` : template,
    {
      qq: opts.userId,
      nickname: opts.nickname,
      groupName: opts.groupName,
      memberCount: opts.memberCount,
    },
    // 测试消息绝不 @ 真人（避免误扰）
    { mention: opts.test ? false : cfg.mention },
  );
  if (opts.test) {
    // 「测试」标记必须真的发出去（不只是在返回值里），否则群里看不出这是测试
    built.segments.push(Structs.text('\n（测试消息，未真实 @ 新人）'));
  }
  const text = built.segments
    .map((s) => (s.type === 'at' ? `@${(s as any).data?.qq ?? ''}` : String((s as any).data?.text ?? '')))
    .join('');
  return { segments: built.segments, text, mentioned: built.mentioned, config: cfg };
}

/**
 * 入群事件专用：先尽力取群名/人数/昵称（失败就降级），再组装迎新消息。
 * 任何异常都被吞掉并转日志 —— 迎新失败不能影响机器人主循环。
 */
export async function buildWelcomeMessageForJoin(opts: {
  groupId: string;
  userId: string;
  client: NapcatSender;
}): Promise<WelcomeMessage | null> {
  const { groupId, userId, client } = opts;
  if (!getWelcomeConfig(groupId).enabled) return null;

  let groupName: string | undefined;
  let memberCount: number | string | undefined;
  let nickname: string | undefined;
  try {
    const info = await client('get_group_info', { group_id: Number(groupId) });
    groupName = info?.group_name || undefined;
    memberCount = info?.member_count || undefined;
  } catch (e) {
    console.error('[迎新] 取群信息失败，相关变量留空:', (e as Error)?.message || e);
  }
  try {
    const member = await client('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
    nickname = member?.card || member?.nickname || undefined;
  } catch (e) {
    console.error('[迎新] 取新人昵称失败，改用 QQ 兜底:', (e as Error)?.message || e);
  }

  return buildWelcomeMessage({ groupId, userId, nickname, groupName, memberCount });
}
