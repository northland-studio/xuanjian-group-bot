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

/**
 * 兜底处理器：没有匹配到具名指令时才会走到这里（例如 `#[3]` 这种"选第几条"）。
 * 单独存放，不进 commands 数组，所以不会出现在 #help 的指令清单里。
 */
let fallbackHandler: CommandHandler | null = null;

export function setFallbackHandler(handler: CommandHandler) {
  fallbackHandler = handler;
}

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
  // 群聊需以 # 或 / 开头；私聊可带前缀也可不带
  // （历史上只用 #，为兼容 /收款码 这类斜杠写法，两种前缀都接受）
  const hasPrefix = msg.startsWith('#') || msg.startsWith('/');
  if (!isPrivate && !hasPrefix) return null;
  const body = hasPrefix ? msg.slice(1) : msg;
  const trimmed = body.trim();
  if (!trimmed) return null;
  // 只按第一段空白切出指令名，参数原样保留（含换行）——
  // 「#迎新 设置」这类需要多行文案的指令靠它保留用户输入的换行。
  const sep = trimmed.search(/\s/);
  const head = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const args = sep === -1 ? '' : trimmed.slice(sep).trim();
  const keyword = head.toLowerCase();
  const entry = commands.find(
    (c) => c.name.toLowerCase() === keyword || c.aliases.some((a) => a.toLowerCase() === keyword),
  );
  if (!entry) {
    // 兜底：`#[3]` 或 `#3` 这类"选第几条"的写法交给 fallbackHandler（不进指令清单）
    const sigil = keyword.replace(/^\[|\]$/g, '');
    if (fallbackHandler && /^\d{1,2}$/.test(sigil)) {
      return {
        entry: { name: '__index__', aliases: [], desc: '', handler: fallbackHandler },
        args: sigil,
      };
    }
    return null;
  }
  return { entry, args };
}
