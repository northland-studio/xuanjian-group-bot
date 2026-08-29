/**
 * 群指令实现（MVP 公开查询）
 */
import { registerCommand, getCommands } from '../core/command.js';
import * as api from '../services/officialApi.js';

/** 格式化贡献点（两位小数） */
function fmt(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  return isNaN(num) ? '0.00' : num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
}
