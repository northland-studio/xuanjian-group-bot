/**
 * 群指令实现（查询 + 拓展功能）
 */
import { registerCommand, getCommands } from '../core/command.js';
import * as api from '../services/officialApi.js';
import { isAdmin } from '../config.js';
import { activityRanking } from '../services/activity.js';

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

  // ==================== 核销（私聊，管理员） ====================
  registerCommand('核销', ['hexiao', 'verify'], '核销码验证（管理员私聊）：核销 <码>', async ({ text: args, userId, isPrivate, reply }) => {
    if (!isPrivate) return reply('核销为敏感操作，请私聊机器人使用。');
    if (!requireAdmin(userId, reply)) return;
    if (!args) return reply('用法：核销 <核销码>');
    const r = await api.verifyCode(args, userId);
    if (!r) return reply('核销服务不可用，请稍后再试。');
    if (r.error) return reply(`核销失败：${r.error}`);
    const it = r.item || {};
    const info = [
      `【核销信息】`,
      `商品：${it.name || ''}`,
      `买家：${it.buyer || ''}`,
      `购买时间：${(it.purchasedAt || '').slice(0, 10)}`,
      r.already ? '⚠ 该码已核销' : `剩余待核销：${r.remaining ?? r.quantity ?? 1}`,
    ];
    if (!r.already) info.push('确认无误请回复：核销确认 <码>');
    reply(info.filter(Boolean).join('\n'));
  });

  registerCommand('核销确认', ['hexiaoqr', 'confirm'], '确认核销（管理员私聊）：核销确认 <码>', async ({ text: args, userId, isPrivate, reply }) => {
    if (!isPrivate) return reply('核销为敏感操作，请私聊机器人使用。');
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
}

/** 简单字符串 hash（用于随机种子） */
function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return h;
}
