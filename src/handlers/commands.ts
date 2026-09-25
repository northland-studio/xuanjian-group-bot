/**
 * 群指令实现（查询 + 拓展功能）
 */
import { registerCommand, getCommands } from '../core/command.js';
import type { CommandContext } from '../core/command.js';
import { Structs } from 'node-napcat-ts';
import * as api from '../services/officialApi.js';
import { isAdmin, config } from '../config.js';
import { activityRanking } from '../services/activity.js';
import { buildSummaryBroadcast } from '../services/payBroadcast.js';

/** 格式化贡献点（两位小数） */
function fmt(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  return isNaN(num) ? '0.00' : num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 从参数中解析目标 QQ（@格式或纯数字） */
function parseTargetQq(args: string): string | null {
  const m = args.match(/(\d{5,12})/);
  return m ? m[1] : null;
}

/** 判断是否管理员；非管理员回复权限提示 */
function requireAdmin(qq: string, reply: (s: string) => void): boolean {
  if (isAdmin(qq)) return true;
  reply('权限不足：该指令仅限管理员使用。');
  return false;
}

export function registerAllCommands() {
  // 帮助
  registerCommand('help', ['帮助', '菜单'], '查看指令列表', ({ reply }) => {
    const lines = ['玄剑公会群机器人指令：'];
    for (const c of getCommands()) {
      lines.push(`#${c.name} — ${c.desc}`);
    }
    lines.push('注：查询/核销等敏感操作请私聊机器人。');
    reply(lines.join('\n'));
  });

  // 档案查询
  registerCommand('档案', ['dangan', 'profile'], '查询成员档案（贡献点/代系/处分）', async ({ text: args, reply }) => {
    if (!args) return reply('用法：#档案 <ID或昵称>');
    const archive = await api.queryArchive(args);
    if (!archive) return reply('未找到该成员档案');
    const u = archive.user || {};
    const gen = u.generation?.name ? ` | 代系：${u.generation.name}` : '';
    reply(
      [
        `【档案】${u.nickname || u.username}`,
        `用户ID：${u.id} | 贡献点：${fmt(u.contribution)}${gen}`,
        `注册：${(u.created_at || '').slice(0, 10)}`,
        u.is_frozen ? '⚠ 账号冻结' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

  // 处分查询
  registerCommand('处分', ['chufen', 'punish'], '查询成员处分记录', async ({ text: args, reply }) => {
    if (!args) return reply('用法：#处分 <ID或昵称>');
    const results = await api.queryDiscipline(args);
    if (!results.length) return reply('该成员暂无生效处分记录');
    const a = results[0].actions?.[0] || results[0];
    reply(`【处分】${a.level_text || '处分'}\n理由：${a.reason || '—'}\n扣点：${a.deduct_points || 0}`);
  });

  // 贡献点排行
  registerCommand('贡献排行', ['gongxian', 'ranking', '排行'], '查看贡献点排行 Top10', async ({ reply }) => {
    const list = await api.contributionRanking(10);
    if (!list.length) return reply('暂无排行数据');
    const lines = ['【贡献点排行】'];
    list.forEach((r: any, i: number) => lines.push(`${i + 1}. ${r.nickname || r.username} — ${fmt(r.contribution)} 点`));
    reply(lines.join('\n'));
  });

  // 签到排行
  registerCommand('签到排行', ['qiandao', 'checkin'], '查看签到排行 Top10', async ({ reply }) => {
    const list = await api.checkinRanking(10);
    if (!list.length) return reply('暂无排行数据');
    const lines = ['【签到排行】'];
    list.forEach((r: any, i: number) => lines.push(`${i + 1}. ${r.nickname || r.username} — 连续 ${r.max_continuous_days || 0} 天`));
    reply(lines.join('\n'));
  });

  // 在线
  registerCommand('在线', ['online', 'zaixian'], '查看官网在线玩家', async ({ reply }) => {
    const players = await api.onlinePlayers();
    if (!players.length) return reply('当前暂无已绑定的玄剑玩家在线');
    reply(`【在线玩家 ${players.length} 人】\n${players.map((p: any) => p.name).join('、')}`);
  });

  // 绑定（群内发起，生成一次性码去官网确认）
  registerCommand('绑定', ['bind', 'qqbind'], '绑定QQ与官网账号（生成一次性码）', async ({ text: args, userId, reply }) => {
    if (!args) return reply('用法：#绑定 <官网用户名或昵称>');
    if (!userId) return reply('无法获取你的QQ号，请私聊机器人操作');
    const result = await api.bindQq(userId, args);
    if (!result) return reply('绑定失败：官网服务不可用或参数错误，请稍后再试');
    if (result.error) return reply(`绑定失败：${result.error}`);
    reply(
      [
        `已为 QQ ${userId} 发起绑定到账号「${result.nickname || result.username}」。`,
        `你的 6 位绑定码：${result.code}`,
        `请到官网「账户设置 → 群机器人绑定」输入绑定码完成确认。`,
        `（${result.expireMinutes || 10} 分钟内有效）`,
      ].join('\n'),
    );
  });

  // 查自己（按当前 QQ 查绑定档案）
  registerCommand('查自己', ['me', 'wode', '我的'], '查询自己的档案（需先绑定QQ）', async ({ userId, reply }) => {
    if (!userId) return reply('无法获取你的QQ号，请私聊机器人操作');
    const me = await api.getUserByQq(userId);
    if (!me) return reply('查询失败：官网服务不可用，请稍后再试');
    if (!me.bound || !me.user) return reply('你尚未绑定官网账号。请在群里发送 #绑定 <用户名>，再按提示到官网确认。');
    const uid = String(me.user.id);
    const archive = await api.queryArchive(uid);
    if (!archive) return reply(`已绑定账号「${me.user.nickname || me.user.username}」，但档案查询失败，请稍后再试`);
    const u = archive.user || {};
    const gen = u.generation?.name ? ` | 代系：${u.generation.name}` : '';
    const dis = (archive.discipline || []).filter((d: any) => d.is_active);
    const disLine = dis.length ? `\n处分：${dis.length} 条生效记录` : '';
    reply(
      [
        `【${u.nickname || u.username} 的档案】`,
        `用户ID：${u.id} | 贡献点：${fmt(u.contribution)}${gen}`,
        `注册：${(u.created_at || '').slice(0, 10)}`,
        u.is_frozen ? '⚠ 账号冻结' : '',
        disLine,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  });

  // ==================== 群活跃统计 ====================
  registerCommand('活跃', ['huoyue', '今日活跃'], '查看今日群活跃排行 Top10', ({ groupId, reply }) => {
    if (!groupId) return reply('请私聊查询或使用群指令');
    const list = activityRanking(groupId, 10);
    if (!list.length) return reply('今天还没有发言记录，快来聊聊天吧～');
    const lines = ['【今日活跃排行】'];
    list.forEach((r, i) => {
      const name = r.name ? `${r.name}(${r.qq.slice(-4)})` : `QQ ${r.qq}`;
      lines.push(`${i + 1}. ${name} — ${r.count} 条`);
    });
    reply(lines.join('\n'));
  });

  registerCommand('昨日活跃', ['zuori'], '查看昨日群活跃排行 Top10', ({ groupId, reply }) => {
    if (!groupId) return reply('请私聊查询或使用群指令');
    const list = activityRanking(groupId, 10, 1);
    if (!list.length) return reply('昨日暂无发言记录');
    const lines = ['【昨日活跃排行】'];
    list.forEach((r, i) => {
      const name = r.name ? `${r.name}(${r.qq.slice(-4)})` : `QQ ${r.qq}`;
      lines.push(`${i + 1}. ${name} — ${r.count} 条`);
    });
    reply(lines.join('\n'));
  });

  // ==================== 日报 / 决策播报 ====================
  registerCommand('日报', ['ribao', 'daily'], '查看官网最新日报', async ({ reply }) => {
    const posts = await api.getPosts('daily', 3);
    if (!posts.length) return reply('暂无日报更新');
    const lines = ['【官网最新日报】'];
    posts.forEach((p: any) => lines.push(`· ${p.title}（${(p.created_at || '').slice(0, 10)}）`));
    lines.push('详情请访问官网查看。');
    reply(lines.join('\n'));
  });

  registerCommand('决策', ['juece', 'decision'], '查看官网最新决策', async ({ reply }) => {
    const posts = await api.getPosts('decision', 3);
    if (!posts.length) return reply('暂无决策更新');
    const lines = ['【官网最新决策】'];
    posts.forEach((p: any) => lines.push(`· ${p.title}（${(p.created_at || '').slice(0, 10)}）`));
    lines.push('详情请访问官网查看。');
    reply(lines.join('\n'));
  });

  // ==================== 抽奖 / 娱乐 ====================
  registerCommand('运势', ['yunshi', 'luck'], '查看今日运势', ({ userId, reply }) => {
    const levels = ['大吉', '中吉', '小吉', '平', '小凶', '大凶'];
    const idx = hashNum(`${userId}-${new Date().toDateString()}`) % levels.length;
    const level = levels[idx];
    const tips = [
      '宜：肝活动、冲贡献榜', '宜：摸鱼、逛贴吧', '宜：钓鱼、种田',
      '宜：社交、拉人入坑', '忌：熬夜刷副本', '宜：低调发育',
    ];
    reply(`【今日运势】\n${level}\n${tips[hashNum(`${userId}-${level}`) % tips.length]}`);
  });

  registerCommand('抽签', ['chouqian', 'lottery'], '抽个签', ({ userId, reply }) => {
    const items = [
      '上上签：好运连连，贡献点滚滚来！',
      '上签：今天适合接任务。',
      '中签：平平淡淡才是真。',
      '下签：小心被处分，注意言行。',
      '吉签：宜签到，宜打卡。',
    ];
    const idx = hashNum(`${userId}-${Date.now()}`) % items.length;
    reply(`【抽签】\n${items[idx]}`);
  });

  registerCommand('掷骰', ['zhitou', 'dice'], '掷骰子（#掷骰 [面数]）', ({ text: args, userId, reply }) => {
    const faces = Math.min(parseInt(args) || 6, 100);
    const roll = (hashNum(`${userId}-${Date.now()}`) % faces) + 1;
    reply(`🎲 掷出 ${faces} 面骰：${roll}`);
  });

  // ==================== 群管理（管理员） ====================
  registerCommand('禁言', ['jinyan', 'mute'], '禁言成员（管理员）：#禁言 @QQ 分钟', async ({ text: args, userId, groupId, client, reply }) => {
    if (!groupId) return reply('请私聊管理员操作');
    if (!requireAdmin(userId, reply)) return;
    const target = parseTargetQq(args);
    const dur = parseInt(args.match(/(\d+)\s*(分钟|分)?/)?.[1] || '') || 10;
    if (!target) return reply('用法：#禁言 @QQ 分钟');
    try {
      await client.send('set_group_ban', { group_id: Number(groupId), user_id: Number(target), duration: dur * 60 });
      reply(`已禁言 ${target} ${dur} 分钟。`);
    } catch (e) {
      reply('禁言失败，请检查参数或权限。');
    }
  });

  registerCommand('解禁', ['jiejin', 'unmute'], '解除禁言（管理员）：#解禁 @QQ', async ({ text: args, userId, groupId, client, reply }) => {
    if (!groupId) return reply('请私聊管理员操作');
    if (!requireAdmin(userId, reply)) return;
    const target = parseTargetQq(args);
    if (!target) return reply('用法：#解禁 @QQ');
    try {
      await client.send('set_group_ban', { group_id: Number(groupId), user_id: Number(target), duration: 0 });
      reply(`已解除 ${target} 的禁言。`);
    } catch (e) {
      reply('解禁失败。');
    }
  });

  registerCommand('踢人', ['tiren', 'kick'], '移出成员（管理员）：#踢人 @QQ', async ({ text: args, userId, groupId, client, reply }) => {
    if (!groupId) return reply('请私聊管理员操作');
    if (!requireAdmin(userId, reply)) return;
    const target = parseTargetQq(args);
    if (!target) return reply('用法：#踢人 @QQ');
    try {
      await client.send('set_group_kick', { group_id: Number(groupId), user_id: Number(target) });
      reply(`已将 ${target} 移出本群。`);
    } catch (e) {
      reply('移出失败，请检查权限。');
    }
  });

  registerCommand('名片', ['mingpian', 'setcard'], '设置成员名片（管理员）：#名片 @QQ 新名片', async ({ text: args, userId, groupId, client, reply }) => {
    if (!groupId) return reply('请私聊管理员操作');
    if (!requireAdmin(userId, reply)) return;
    const m = args.match(/^(@?\d{5,12})\s+(.+)$/);
    if (!m) return reply('用法：#名片 @QQ 新名片');
    const target = m[1].replace('@', '');
    const card = m[2].trim();
    try {
      await client.send('set_group_card', { group_id: Number(groupId), user_id: Number(target), card });
      reply(`已将 ${target} 的名片设置为「${card}」。`);
    } catch (e) {
      reply('设置名片失败。');
    }
  });

  // ==================== 核销查询（群内开放，普通成员可查核销信息/状态） ====================
  registerCommand('核销', ['hexiao', 'verify'], '查询核销码信息与状态：核销 <码>', async ({ text: args, reply }) => {
    if (!args) return reply('用法：核销 <核销码>');
    const r = await api.verifyCode(args);
    if (!r) return reply('核销服务不可用，请稍后再试。');
    if (r.error) return reply(`核销失败：${r.error}`);
    const it = r.item || {};
    const info = [
      `【核销信息】`,
      `商品：${it.name || ''}`,
      `买家：${it.buyer || ''}`,
      `购买时间：${(it.purchasedAt || '').slice(0, 10)}`,
      r.already ? `✅ 状态：已核销（${(r.verifiedAt || '').slice(0, 16)}）` : `⏳ 状态：待核销，剩余 ${r.remaining ?? r.quantity ?? 1} 件`,
    ];
    if (!r.already) info.push('提示：核销确认需管理员操作。');
    reply(info.filter(Boolean).join('\n'));
  });

  registerCommand('核销确认', ['hexiaoqr', 'confirm'], '确认核销（管理员私聊）：核销确认 <码>', async ({ text: args, userId, isPrivate, reply }) => {
    if (!isPrivate) return reply('核销确认为敏感操作，请私聊管理员使用。');
    if (!requireAdmin(userId, reply)) return;
    if (!args) return reply('用法：核销确认 <核销码>');
    const r = await api.confirmCode(args, userId);
    if (!r) return reply('核销服务不可用，请稍后再试。');
    if (r.error) return reply(`核销失败：${r.error}`);
    reply(`核销成功：${r.itemName || ''}${r.quantity ? `，共 ${r.quantity} 件` : ''}`);
  });

  // ==================== 任务验证码（私聊） ====================
  registerCommand('任务码', ['renwuma', 'taskcode'], '提交玩家任务完成验证码（私聊）：任务码 <任务ID> <验证码>', async ({ text: args, userId, isPrivate, reply }) => {
    if (!isPrivate) return reply('任务验证码为敏感操作，请私聊机器人使用。');
    const m = args.match(/^(\d+)\s+([A-Za-z0-9-]+)$/i);
    if (!m) return reply('用法：任务码 <任务ID> <验证码>');
    const r = await api.completePlayerTask(m[1], m[2], userId);
    if (!r) return reply('任务服务不可用，请稍后再试。');
    if (r.error) return reply(`提交失败：${r.error}`);
    reply(`✅ 任务完成，${r.reward ?? ''} 贡献点已到账！`);
  });

  // ==================== 贡献点扫码支付 ====================
  // 设计决策 3：机器人只负责出码与提示，扣款一律回到付款方本人已登录的官网会话确认（不做免密）。

  registerCommand('收款码', ['shoukuanma', 'qr', 'receive', '收款'], '生成我的收款码（90 秒）：收款码 [金额] [备注]', async (ctx) => {
    const { userId, reply } = ctx;
    if (!userId) return reply('无法获取你的QQ号，请私聊机器人操作。');
    const { amount, note } = parseAmountNote(ctx.text);
    const r = await api.payReceiveCode(userId, amount, note);
    if (!r.ok || !r.data) return reply(`生成收款码失败：${r.error || '官网服务不可用，请稍后再试'}`);
    const d = r.data;
    const caption = [
      `【收款码】${d.user?.nickname || d.user?.username || userId}`,
      `金额：${d.amount == null ? '由付款方扫码后填写' : `${fmt(d.amount)} 贡献点`}${d.note ? ` ｜ 备注：${d.note}` : ''}`,
      `有效期 ${d.ttlSeconds || 90} 秒，过期请重新生成。`,
      '⚠ 只出码不扣款：请付款方扫码后，在本人登录的官网会话里确认支付（机器人不会代扣）。',
      `网页链接：${d.url}`,
    ].join('\n');
    await sendQrReply(ctx, d.qrUrl || api.payQrImageUrl(d.url), caption, d.url);
  });

  registerCommand('付款码', ['fukuanma', 'paycode', '付款'], '生成我的付款码（60 秒，供收款方反扫）：付款码', async (ctx) => {
    const { userId, reply } = ctx;
    if (!userId) return reply('无法获取你的QQ号，请私聊机器人操作。');
    const r = await api.payPayerCode(userId);
    if (!r.ok || !r.data) return reply(`生成付款码失败：${r.error || '官网服务不可用，请稍后再试'}`);
    const d = r.data;
    const caption = [
      `【付款码】${d.user?.nickname || d.user?.username || userId}`,
      `有效期 ${d.remainSeconds ?? d.ttlSeconds ?? 60} 秒（每 ${d.ttlSeconds || 60} 秒刷新一次，过期请重新生成）。`,
      '使用方式：让收款方在官网「支付中心 → 扫一扫」扫这张图并填写金额。',
      '⚠ 扫码不等于付款：需要你本人在网页上确认后才会划转。',
      `网页链接：${d.url}`,
    ].join('\n');
    await sendQrReply(ctx, d.qrUrl || api.payQrImageUrl(d.url), caption, d.url);
  });

  registerCommand(
    '缴费单',
    ['jiaofeidan', 'charge', '收费'],
    '创建缴费单（管理员/认证成员）：缴费单 <标题> <金额> [@某人...]',
    async (ctx) => {
      const { userId, reply } = ctx;
      if (!userId) return reply('无法获取你的QQ号，请私聊机器人操作。');
      const { mentions, rest } = extractMentions(ctx.text);
      if (!rest) {
        return reply(
          '用法：#缴费单 <标题> <金额> [@某人...]\n'
          + '例如：#缴费单 十一团建费 20 @张三 @李四\n'
          + '（金额可留空 = 按人各自填写；加「全员」= 开放缴纳，不限名单）',
        );
      }
      const openAll = /(全员|全部|所有人)/.test(rest);
      const cleaned = rest.replace(/(全员|全部|所有人)/g, ' ').replace(/\s+/g, ' ').trim();
      const { amount, note } = parseAmountNote(cleaned);
      const title = (note || cleaned).trim();
      if (!title) return reply('请填写缴费单标题，例如：#缴费单 十一团建费 20 @张三');

      const r = await api.payCharge(userId, { title, amount, targets: mentions, openAll });
      if (!r.ok || !r.data) return reply(`创建缴费单失败：${r.error || '官网服务不可用，请稍后再试'}`);
      const d = r.data;
      // 创建成功后优先用官网 charge-poster 返回的 url 发海报（并取进度用于催缴文案）；
      // 该接口不可用时退回公开渲染地址，保证「创建成功」这件事始终能发出图/链接。
      const poster = await resolveChargePoster(d.token);
      const roster = openAll ? '开放缴纳（不限名单）' : `${poster.count ?? d.targetCount ?? 0} 人`;
      const caption = [
        `【缴费单已创建】${poster.title || d.title}`,
        `金额：${d.amount == null ? '按人填写' : `${fmt(d.amount)} 贡献点/人`} ｜ 名单：${roster}`,
        poster.progressLine,
        `截止：${poster.deadline || d.deadline || '—'}${poster.expired ? '（已截止）' : ''}`,
        d.unmatchedQq?.length
          ? `⚠ 以下 @ 成员未绑定官网账号，已按 QQ 号码登记：${d.unmatchedQq.map((x: any) => x.qq).join('、')}`
          : '',
        '⚠ 名单成员需自己打开链接，在本人登录的官网会话里确认支付（机器人不会代扣）。',
        `网页链接：${poster.pageUrl}`,
      ].filter(Boolean).join('\n');
      await sendPosterReply(ctx, poster.url, caption, poster.pageUrl);
    },
  );

  registerCommand(
    '转分',
    ['zhuanfen', 'transfer', '付款给'],
    '付款给某成员（只出码，不扣款）：转分 @某人 <金额> [备注]',
    async (ctx) => {
      const { userId, reply } = ctx;
      const { mentions, rest } = extractMentions(ctx.text);
      if (!mentions.length) {
        return reply('用法：#转分 @某人 <金额> [备注]\n例如：#转分 @张三 50 买材料\n（请用 @ 提及收款人）');
      }
      const { amount, note } = parseAmountNote(rest);
      if (amount === undefined) {
        return reply('请填写转账金额，例如：#转分 @张三 50 买材料');
      }
      if (mentions[0] === userId) return reply('不能给自己转分，请 @ 其他成员。');

      // 只出「付给该成员」的收款码，不做任何扣款；对方未绑定时官网会返回明确提示文案
      const r = await api.payReceiveCode(mentions[0], amount, note);
      if (!r.ok || !r.data) {
        return reply(`无法生成收款码：${r.error || '官网服务不可用，请稍后再试'}`);
      }
      const d = r.data;
      const caption = [
        `【代收码】收款人：${d.user?.nickname || d.user?.username || mentions[0]}（QQ ${mentions[0]}）`,
        `金额：${fmt(amount)} 贡献点${d.note ? ` ｜ 备注：${d.note}` : ''}`,
        `有效期 ${d.ttlSeconds || 90} 秒，过期请重新生成。`,
        '⚠ 机器人只出码、不扣款：请用官网「支付中心 → 扫一扫」扫码，并在本人会话中确认支付。',
        `网页链接：${d.url}`,
      ].join('\n');
      await sendQrReply(ctx, d.qrUrl || api.payQrImageUrl(d.url), caption, d.url);
    },
  );

  // 缴费单海报图（催缴：按 token/链接重发海报）
  registerCommand(
    '缴费单图',
    ['jiaofeidantu', 'chargeimg', '缴费单海报'],
    '重发缴费单海报图（催缴）：缴费单图 <token或链接>',
    async (ctx) => {
      const token = api.extractPayToken(ctx.text);
      if (!token) return ctx.reply('用法：#缴费单图 <缴费单链接或 token>\n例如：#缴费单图 https://xuanjian.top/pay/charge/xxxxxxxxxxxxxxxx');
      const poster = await resolveChargePoster(token);
      // 官网明确回答「缴费单不存在」时不再发一张必然 404 的图，直接回显官网文案
      if (poster.missing) {
        return ctx.reply(`重发海报失败：${poster.error || '缴费单不存在'}\n请确认缴费单链接或 token 是否正确。`);
      }
      const caption = [
        `【缴费单海报】${poster.title || ''}`.trim(),
        poster.progressLine,
        poster.deadline ? `截止：${poster.deadline}${poster.expired ? '（已截止）' : ''}` : '',
        '⚠ 请名单内成员打开链接，在本人登录的官网会话里确认支付（机器人不会代扣）。',
        `网页链接：${poster.pageUrl}`,
      ].filter(Boolean).join('\n');
      await sendPosterReply(ctx, poster.url, caption, poster.pageUrl);
    },
  );

  // 待审批列表（管理员查看）
  registerCommand('审批', ['shenpi', 'approvals', '待审批'], '查看待审批的大额支付（管理员）：审批', async ({ reply }) => {
    const r = await api.payPendingApprovals();
    if (!r.ok || !r.data) return reply(`查询待审批失败：${r.error || '官网服务不可用，请稍后再试'}`);
    const list: any[] = Array.isArray(r.data.approvals) ? r.data.approvals : [];
    if (!list.length) return reply('当前没有待审批的支付。');
    const lines = [`【待审批支付 ${list.length} 笔】`];
    for (const a of list.slice(0, 10)) {
      lines.push(`#${a.id} ${fmt(a.amount)} 点｜${a.payerName || '—'} → ${a.payeeName || '—'}${a.note ? `｜${a.note}` : ''}`);
      lines.push(`　通过： #通过 ${a.id}　驳回： #驳回 ${a.id}`);
    }
    if (list.length > 10) lines.push(`…另有 ${list.length - 10} 笔未列出。`);
    const t = r.data.thresholds;
    if (t) lines.push(`阈值：单笔 ${fmt(t.single)} / 日累计 ${fmt(t.daily)} / 超 ${fmt(t.approval)} 需审批`);
    lines.push('注：审批按你绑定的官网账号权限判定，非管理员会被拒绝。');
    reply(lines.join('\n'));
  });

  // 审批通过 / 驳回（管理员；权限最终由官网按绑定账号判定）
  const doApprove = async (ctx: CommandContext, action: 'approve' | 'reject') => {
    const label = action === 'approve' ? '通过' : '驳回';
    const id = (ctx.text.match(/\d+/) || [])[0];
    if (!id) return ctx.reply(`用法：#${label} <流水ID>\n先用 #审批 查看待审批列表（形如 #${label} 12）`);
    const r = await api.payApprove(id, ctx.userId, action);
    if (!r.ok || !r.data) return ctx.reply(`${label}失败：${r.error || '官网服务不可用，请稍后再试'}`);
    ctx.reply(r.data.message || `已${label} #${id}`);
  };

  registerCommand('通过', ['tongguo', 'approve', '同意'], '审批通过一笔大额支付（管理员）：通过 <ID>', (ctx) =>
    doApprove(ctx, 'approve'),
  );

  registerCommand('驳回', ['bohui', 'reject', '拒绝'], '驳回一笔大额支付（管理员）：驳回 <ID>', (ctx) =>
    doApprove(ctx, 'reject'),
  );

  // 财务月报（管理员）
  registerCommand('月报', ['yuebao', 'monthly'], '发送本月财务对账海报（管理员）：月报', async (ctx) => {
    if (!requireAdmin(ctx.userId, ctx.reply)) return;
    const b = await buildSummaryBroadcast();
    if (!b.imageUrl) return ctx.reply(`${b.caption}\n（海报图暂不可用，请打开对账后台：${b.fallbackUrl}）`);
    await sendPosterReply(ctx, b.imageUrl, b.caption, b.fallbackUrl);
  });

  // 十一服（115）状态：只读查询，官网侧走 Minecraft 状态协议（115 上不部署任何进程）
  registerCommand('服务器', ['server', '115', '在线状态', '服务器状态'], '查看十一服（115）状态：服务器', async (ctx) => {
    const r = await api.mcStatus('s115');
    if (!r.ok || !r.data) return ctx.reply(`查询服务器状态失败：${r.error || '官网服务不可用，请稍后再试'}`);
    const d = r.data;
    if (!d.online) {
      return ctx.reply(`【十一服·历史展览馆】当前无法连接：${d.error || '离线'}\n地址：115.190.153.44:25565`);
    }
    const p = d.players || {};
    const sample = Array.isArray(p.sample) && p.sample.length ? `\n在线：${p.sample.slice(0, 10).join('、')}` : '';
    ctx.reply(
      [
        `【十一服·历史展览馆】${d.version || ''}`,
        `在线：${p.online ?? 0} / ${p.max ?? '?'} 人${sample}`,
        d.motd ? `MOTD：${String(d.motd).split('\n')[0]}` : '',
        `延迟：${d.latencyMs} ms ｜ 地址：115.190.153.44:25565`
      ].filter(Boolean).join('\n')
    );
  });
}

/** 简单字符串 hash（用于随机种子） */
function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

/* ==================== 缴费单海报辅助 ==================== */

interface ChargePoster {
  /** 海报图地址（优先官网 charge-poster 返回的 url） */
  url: string;
  /** 缴费单网页链接（名单成员在这里确认支付） */
  pageUrl: string;
  /** 缴费单标题（官网数据，取不到时用创建返回的标题） */
  title?: string;
  /** 截止时间 */
  deadline?: string;
  /** 是否已截止 */
  expired?: boolean;
  /** 名单人数（charge-poster 的 stats.count） */
  count?: number;
  /** 「已缴 x/y 人 ｜ a/b 点」进度行；无 stats 时为空串 */
  progressLine: string;
  /** 官网明确返回 404「缴费单不存在」 */
  missing: boolean;
  /** 官网错误文案 */
  error?: string;
}

/**
 * 解析缴费单海报（催缴 / 创建后发图共用）：
 * 1. 先调官网 `GET /api/qqbot/pay/charge-poster?token=`（X-Bot-Token）拿官方 url 与进度统计；
 * 2. 接口不可用（网络异常 / 5xx）时退回公开渲染地址 `/api/pay/render/charge/<token>.png`，
 *    保证「发图」这条路径不会因为多调一个接口而整体失败；
 * 3. 官网明确回答 404（缴费单不存在）时置 `missing`，由调用方决定提示方式。
 */
async function resolveChargePoster(token: string): Promise<ChargePoster> {
  const fallback: ChargePoster = {
    url: api.payChargePosterUrl(token),
    pageUrl: api.payChargePageUrl(token),
    progressLine: '',
    missing: false,
  };
  const r = await api.payChargePosterInfo(token);
  if (r.status === 404) return { ...fallback, missing: true, error: r.error };
  if (!r.ok || !r.data?.url) return fallback;
  const d = r.data;
  const s = d.stats || null;
  const count = s ? Number(s.count) || 0 : undefined;
  return {
    url: String(d.url),
    pageUrl: String(d.pageUrl || fallback.pageUrl),
    title: d.title,
    deadline: d.deadline,
    expired: !!d.expired,
    count,
    progressLine: s ? `进度：已缴 ${Number(s.paidCount) || 0}/${count} 人 ｜ ${fmt(s.paidSum)}/${fmt(s.total)} 点` : '',
    missing: false,
  };
}

/* ==================== 扫码支付辅助函数 ==================== */

/**
 * 从指令参数里提取 @ 提及的 QQ。
 * 提及标记由 index.ts 的 buildRawText 注入（`[CQ:at,qq=<QQ>]`）。
 * @returns { mentions: 被提及的 QQ 列表, rest: 去掉提及后的剩余文本 }
 */
function extractMentions(text: string): { mentions: string[]; rest: string } {
  const mentions: string[] = [];
  const rest = String(text || '').replace(/\[CQ:at,qq=(\d{5,12})\]/g, (_m, qq: string) => {
    mentions.push(qq);
    return ' ';
  });
  return { mentions, rest: rest.replace(/\s+/g, ' ').trim() };
}

/**
 * 解析「金额 [备注]」：
 * 首个形如数字（最多两位小数、大于 0）的 token 视为金额，其余 token 作为备注/标题。
 */
function parseAmountNote(text: string): { amount?: number; note?: string } {
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  let amount: number | undefined;
  const rest: string[] = [];
  for (const t of tokens) {
    const n = Number(t);
    if (amount === undefined && /^\d+(\.\d{1,2})?$/.test(t) && n > 0) {
      amount = n;
      continue;
    }
    rest.push(t);
  }
  return { amount, note: rest.join(' ').trim() || undefined };
}

/**
 * 发送「二维码/海报图片 + 说明文字」（群内回群、私聊回私聊）。
 * 图片发送失败（如 NapCat 拉取图片超时、签名链接过期）时退回文字链接，保证信息不丢。
 */
async function sendQrReply(ctx: CommandContext, imageUrl: string, caption: string, fallbackUrl: string): Promise<void> {
  const message = [Structs.image(imageUrl), Structs.text(`\n${caption}`)];
  try {
    if (ctx.groupId) {
      await ctx.client.send('send_group_msg', { group_id: Number(ctx.groupId), message });
    } else {
      await ctx.client.send('send_private_msg', { user_id: Number(ctx.userId), message });
    }
  } catch (e) {
    ctx.reply(`${caption}\n（图片发送失败，请直接点开链接：${fallbackUrl}）`);
  }
}

/**
 * 发送海报图（与二维码同一套收发与降级逻辑，语义化别名，便于缴费单/月报复用）。
 */
async function sendPosterReply(ctx: CommandContext, imageUrl: string, caption: string, fallbackUrl: string): Promise<void> {
  await sendQrReply(ctx, imageUrl, caption, fallbackUrl);
}
