/**
 * 玄剑公会 QQ 群机器人入口
 * 基于 node-napcat-ts 正向连接 NapCatQQ。
 */
import { NCWebsocket, Structs } from 'node-napcat-ts';
import { config, isAllowedGroup } from './config.js';
import { parseCommand } from './core/command.js';
import { registerAllCommands } from './handlers/commands.js';
import { recordActivity } from './services/activity.js';
import { startPayBroadcasts } from './services/payBroadcast.js';
import type { GroupMessage, GroupIncreaseApprove, GroupIncreaseInvite, PrivateFriendMessage, SendMessageSegment } from 'node-napcat-ts';

// ===== 全局错误兜底：记录完整堆栈，避免静默退出 =====
process.on('uncaughtException', (e) => {
  console.error('[bot][uncaughtException]', e);
});
process.on('unhandledRejection', (e) => {
  console.error('[bot][unhandledRejection]', e);
});

/**
 * 把消息段拼成指令解析用的文本。
 * - 文本段原样拼接（行为与改造前一致）；
 * - @ 提及转成 `[CQ:at,qq=<QQ>]` 标记，便于「转分 / 缴费单 / 禁言」等需要 @某人的指令取到被提及的 QQ。
 * 纯文本消息的解析结果不变，不影响既有指令。
 */
function buildRawText(message: unknown): string {
  if (!Array.isArray(message)) return String(message ?? '');
  return message
    .map((seg: any) => {
      const text = seg?.data?.text;
      if (typeof text === 'string') return text;
      if (seg?.type === 'at' && seg?.data?.qq) return `[CQ:at,qq=${seg.data.qq}]`;
      return '';
    })
    .join('');
}

async function main() {
  console.log('[bot] 玄剑公会群机器人启动中...');

  // 初始化 NapCat 连接
  const napcat = new NCWebsocket(
    config.napcat.baseUrl
      ? { baseUrl: config.napcat.baseUrl, accessToken: config.napcat.token }
      : {
          protocol: config.napcat.protocol,
          host: config.napcat.host,
          port: config.napcat.port,
          accessToken: config.napcat.token,
        },
  );

  // 注册指令
  registerAllCommands();

  // ===== 群消息 =====
  napcat.on('message.group', async (ctx: GroupMessage) => {
    try {
      const groupId = String(ctx.group_id);
      if (!isAllowedGroup(groupId)) return;
      const userId = String(ctx.user_id);
      const raw = buildRawText(ctx.message);
      const parsed = parseCommand(raw, false);
      // 记录群活跃（无论是否指令）
      recordActivity(groupId, userId, ctx.sender?.nickname || ctx.sender?.card || '');
      if (!parsed) return;
      const reply = (msg: string) =>
        napcat
          .send('send_group_msg', { group_id: ctx.group_id, message: [Structs.text(msg)] as SendMessageSegment[] })
          .catch(() => {});
      await parsed.entry.handler({
        text: parsed.args,
        userId,
        groupId,
        isPrivate: false,
        reply,
        client: { send: (m: string, p: Record<string, unknown>) => napcat.send(m as any, p as any) },
      });
    } catch (e) {
      console.error('[群消息处理错误]', e);
    }
  });

  // ===== 私聊消息 =====
  napcat.on('message.private.friend', async (ctx: PrivateFriendMessage) => {
    try {
      const userId = String(ctx.user_id);
      const raw = buildRawText(ctx.message);
      const parsed = parseCommand(raw, true);
      if (!parsed) return;
      const reply = (msg: string) =>
        napcat
          .send('send_private_msg', { user_id: ctx.user_id, message: [Structs.text(msg)] as SendMessageSegment[] })
          .catch(() => {});
      await parsed.entry.handler({
        text: parsed.args,
        userId,
        isPrivate: true,
        reply,
        client: { send: (m: string, p: Record<string, unknown>) => napcat.send(m as any, p as any) },
      });
    } catch (e) {
      console.error('[私聊消息处理错误]', e);
    }
  });

  // ===== 入群欢迎 =====
  napcat.on('notice.group_increase', (ctx: GroupIncreaseApprove | GroupIncreaseInvite) => {
    try {
      const groupId = String(ctx.group_id);
      if (!isAllowedGroup(groupId)) return;
      napcat
        .send('send_group_msg', {
          group_id: ctx.group_id,
          message: [Structs.text(`欢迎新成员加入玄剑公会！\n输入 #帮助 查看机器人指令。`)] as SendMessageSegment[],
        })
        .catch(() => {});
    } catch (e) {
      /* 忽略 */
    }
  });

  // 优雅退出
  const shutdown = (sig?: string) => {
    console.log(`[bot] 收到信号 ${sig}，正在退出...`);
    napcat.disconnect().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // 连接 NapCat（失败自动重试，等待 NapCat 上线）
  const CONNECT_RETRY_MS = 10000;
  for (;;) {
    try {
      await napcat.connect();
      break;
    } catch (e) {
      console.error(`[bot] NapCat 连接失败，${CONNECT_RETRY_MS / 1000}s 后重试:`, (e as Error).message || e);
      await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
  console.log(`[bot] 已连接 NapCat（${config.napcat.baseUrl || `${config.napcat.host}:${config.napcat.port}`}）`);

  // ===== 支付播报（待审批轮询 + 月报/周报；PAY_BROADCAST=on 才启用）=====
  // 发送失败已由服务内部吞掉并降级为日志，这里再兜一层，避免任何异常影响机器人主循环。
  startPayBroadcasts(async (groupId, message) => {
    await napcat.send('send_group_msg', { group_id: groupId, message } as any);
  });

  // 保持进程存活：确保事件循环有活跃句柄，避免 main() 返回后进程退出
  // 同时监听 NapCat 连接断开，便于排查
  setInterval(() => {
    // 心跳占位（保持事件循环活跃）
  }, 60000);

  // 连接断开日志（通过事件）
  napcat.on('socket.close', () => console.log('[bot] NapCat 连接已关闭'));
  napcat.on('socket.error', (e: any) => console.error('[bot] NapCat 连接错误:', e));

  // 永不 resolve，保持 main() 挂起
  await new Promise<void>(() => {});
}

main().catch((e) => {
  console.error('[bot] 启动失败:', e);
  process.exit(1);
});
