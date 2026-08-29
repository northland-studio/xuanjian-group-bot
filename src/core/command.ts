/**
 * 指令系统：注册与分发
 * 群指令前缀为 `#`，私聊指令不带前缀。
 */
export type ReplyFn = (msg: string) => void;

/** 指令处理上下文 */
export interface CommandContext {
  /** 指令参数（去头部关键字后的剩余文本） */
  text: string;
  /** 发送者 QQ */
  userId: string;
  /** 群号（群消息时有） */
  groupId?: string;
  /** 是否私聊 */
  isPrivate: boolean;
  /** 回复消息（群内回群，私聊回私聊） */
  reply: ReplyFn;
  /** 调用 NapCat API（如 send、set_group_ban 等） */
  client: {
    send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  };
}

export type CommandHandler = (ctx: CommandContext) => Promise<void> | void;

interface CommandEntry {
  name: string;           // 主指令
  aliases: string[];      // 别名
  desc: string;           // 帮助描述
  handler: CommandHandler;
}

const commands: CommandEntry[] = [];

export function registerCommand(name: string, aliases: string[], desc: string, handler: CommandHandler) {
  commands.push({ name, aliases, desc, handler });
}

export function listCommands() {
  return commands;
}

/** 供 help 使用 */
export function getCommands() {
  return commands;
}

/**
 * 解析消息为指令调用。
 * @param raw 原始消息
 * @param isPrivate 是否私聊
 * @returns 匹配的指令入口 + 参数文本
 */
export function parseCommand(raw: string, isPrivate: boolean): { entry: CommandEntry; args: string } | null {
  const msg = raw.trim();
  // 群聊需以 # 开头；私聊可带 # 也可不带
  if (!isPrivate && !msg.startsWith('#')) return null;
  const body = msg.startsWith('#') ? msg.slice(1) : msg;
  const trimmed = body.trim();
  if (!trimmed) return null;
  const [head, ...rest] = trimmed.split(/\s+/);
  const keyword = head.toLowerCase();
  const entry = commands.find(
    (c) => c.name.toLowerCase() === keyword || c.aliases.some((a) => a.toLowerCase() === keyword),
  );
  if (!entry) return null;
  return { entry, args: rest.join(' ').trim() };
}
