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
}
