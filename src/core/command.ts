/**
 * 指令系统：注册与分发
 * 群指令前缀为 `#`，私聊指令不带前缀。
 */
export type CommandHandler = (ctx: { text: string; userId: string; groupId?: string; reply: (msg: string) => void }) => Promise<void> | void;

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
