/**
 * 机器人支付指令干跑（不发真实消息、不碰生产数据）
 * 用法：cd xuanjian-group-bot && node scripts/dryrun-pay.mjs
 * 校验：指令注册与别名、请求 URL/鉴权头/请求体、回复文案与发图调用
 */
process.env.OFFICIAL_API_BASE = 'https://xuanjian.top';
process.env.OFFICIAL_BOT_TOKEN = 'dryrun-token';
process.env.NODE_ENV = 'test';

const calls = [];
globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const auth = headers['X-Bot-Token'] || headers['x-bot-token'] || (headers.get && headers.get('X-Bot-Token'));
    calls.push({ url: String(url), method: init.method || 'GET', auth, body: init.body ? String(init.body) : null });
    const payload = {
        ok: true, token: 'TESTTOKEN1234567890', url: 'https://xuanjian.top/pay/TESTTOKEN1234567890',
        qrUrl: 'https://xuanjian.top/api/pay/qr.png?text=TESTTOKEN1234567890',
        ttlSeconds: 90, remainSeconds: 60, amount: 5, note: '测试备注',
        user: { id: 2, username: 'morzane', nickname: '蓦然' }, todayPaid: 0, records: [],
        title: '团建费', targetCount: 3, deadline: '2026-10-02 16:00:00'
    };
    return { ok: true, status: 200, headers: new Map(), json: async () => payload, text: async () => JSON.stringify(payload) };
};

const { registerAllCommands } = await import('../dist/handlers/commands.js');
const { getCommands } = await import('../dist/core/command.js');

registerAllCommands();
const all = getCommands();
const entries = Array.isArray(all) ? all : Object.values(all);
console.log(`已注册指令 ${entries.length} 条`);

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' · ' + extra : ''}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' · ' + extra : ''}`); }
};
const find = (...names) => entries.find(e => {
    const cands = [e.name, ...(e.aliases || [])].map(x => String(x).toLowerCase());
    return names.some(n => cands.includes(n.toLowerCase()));
});

async function run(entry, { userId, groupId, text }) {
    const replies = [];
    const sent = [];
    const ctx = {
        userId, groupId, text,
        reply: (m) => replies.push(String(m)),
        client: { send: async (action, params) => { sent.push({ action, params }); } },
        event: {}, isPrivate: !groupId
    };
    await entry.handler(ctx);
    return { replies, sent, calls: calls.splice(0) };
}

// 注意：生产 ctx.text 是 parseCommand 之后的「参数部分」（不含指令名），这里保持一致
const cases = [
    { label: '收款码', names: ['收款码', 'shoukuanma', 'qr', 'receive'], text: '5 测试备注', expectApi: '/api/qqbot/pay/receive-code' },
    { label: '付款码', names: ['付款码', 'fukuanma', 'paycode'], text: '', expectApi: '/api/qqbot/pay/payer-code' },
    { label: '缴费单', names: ['缴费单', 'jiaofeidan', 'charge'], text: '团建费 20', expectApi: '/api/qqbot/pay/charge' },
    { label: '转分', names: ['转分', 'zhuanfen', 'transfer'], text: '[CQ:at,qq=123456789] 50 买材料', expectApi: '/api/qqbot/pay/receive-code' }
];

console.log('\n=== 指令干跑 ===');
for (const c of cases) {
    const entry = find(...c.names);
    if (!entry) { check(`${c.label} 已注册`, false); continue; }
    check(`${c.label} 已注册`, true, `别名 ${(entry.aliases || []).join('/') || '无'}`);
    const { replies, sent, calls: apiCalls } = await run(entry, { userId: '1365146774', groupId: '860336849', text: c.text });
    const call = apiCalls[0];
    check(`  ${c.label} 调用了 ${c.expectApi}`, !!call && call.url.includes(c.expectApi), call ? call.url.replace('https://xuanjian.top', '') : '未发起请求');
    check(`  ${c.label} 带上 X-Bot-Token`, !!call && !!call.auth, call && call.auth ? '有' : '无');
    check(`  ${c.label} 群内发图（send_group_msg）`, sent.some(s => s.action === 'send_group_msg'), sent.map(s => s.action).join(',') || '无');
    const textOut = replies.join(' | ') || JSON.stringify(sent[0]?.params?.message || []).slice(0, 120);
    check(`  ${c.label} 回复含关键信息`, /收款码|付款码|缴费单|链接|xuanjian\.top/.test(textOut), textOut.replace(/\s+/g, ' ').slice(0, 110));
}

console.log('\n=== 边界 ===');
const rc = find('收款码');
if (rc) {
    const { replies, calls: apiCalls } = await run(rc, { userId: '', groupId: '', text: '收款码 5' });
    check('无 QQ 号时提示私聊', /QQ|私聊/.test(replies.join('')), replies.join('').slice(0, 60));
    check('无 QQ 号时不请求官网', apiCalls.length === 0);
}
const charge = find('缴费单');
if (charge) {
    const { replies, sent } = await run(charge, { userId: '1365146774', groupId: '860336849', text: '' });
    const out = replies.join(' | ') || JSON.stringify(sent[0]?.params?.message || []);
    check('缴费单缺参数时给用法', /用法|例如|请填写/.test(out), out.replace(/\s+/g, ' ').slice(0, 140));
}

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
