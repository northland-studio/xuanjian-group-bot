/**
 * 预热「指令帮助图」本地缓存（部署后跑一次，避免群里第一个 #help 现拉）
 * 用法：cd xuanjian-group-bot && npm run build && node scripts/prewarm-help.mjs
 *
 * 做什么：按真实指令注册表生成 payload → POST 官网 /api/qqbot/help-card →
 *         把官网渲染好的 PNG 下载到 data/help-cards/<hash>.png。
 * 只写本地缓存文件，不发任何 QQ 消息。
 * 退出码：0 成功 / 1 官网生成失败 / 2 图片没能落到本地（此时 #help 会退回在线地址，仍可用）
 */
const { registerAllCommands } = await import('../dist/handlers/commands.js');
const { getHelpCard, localHelpImagePath, helpCardCaption } = await import('../dist/services/helpCard.js');
const fs = await import('fs');

registerAllCommands();

const card = await getHelpCard(true);
if (!card.ok) {
  console.error(`预热失败（官网生成）：${card.error || '未知错误'}`);
  process.exit(1);
}

console.log(`help-card: count=${card.count} hash=${card.hash || '-'}`);
console.log(`在线地址：${card.url}`);

const local = localHelpImagePath();
if (!local) {
  console.error('预热失败（图片未落本地）：#help 仍可用，但会退回发在线地址');
  process.exit(2);
}

console.log(`本地图片：${local}（${(fs.statSync(local).size / 1024).toFixed(1)}KB）`);
console.log(`发图文案：${helpCardCaption(card.count)}`);
