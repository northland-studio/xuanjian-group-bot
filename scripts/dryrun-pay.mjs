/**
 * 机器人支付指令 + 播报服务干跑（不发真实消息、不碰生产数据）
 * 用法：cd xuanjian-group-bot && npm run build && node scripts/dryrun-pay.mjs
 *
 * 覆盖：
 *  - 指令注册/别名、请求 URL、X-Bot-Token 鉴权头、群内发图调用、回复文案
 *  - 缴费单改发 charge-poster 海报图（含进度/催缴文案与故障降级）、缴费单图（token/链接/不存在）
 *  - 审批 / 通过 / 驳回（含官网 403/409/404 文案回显）、月报（签名链接）
 *  - 播报服务：待审批轮询去重（游标持久化 + 重启不重复）、失败静默退避、月报/周报内容组装、定时任务到点只触发一次
 *  - 开关：PAY_BROADCAST 缺省 off（子进程探针验证不建定时器、不请求官网）
 * 注意：生产 ctx.text 是 parseCommand 之后的「参数部分」（不含指令名），这里保持一致。
 */
process.env.OFFICIAL_API_BASE = 'https://xuanjian.top';
process.env.OFFICIAL_SITE_BASE = 'https://xuanjian.top';
process.env.OFFICIAL_BOT_TOKEN = 'dryrun-token';
process.env.PAY_BROADCAST = 'on';
process.env.BROADCAST_GROUP_ID = '860336849';
process.env.APPROVAL_GROUP_ID = '860336849';
process.env.ALLOWED_GROUPS = '860336849';
process.env.ADMIN_QQ = '1365146774';
process.env.NODE_ENV = 'test';

const fs = await import('fs');
const path = await import('path');
const { fileURLToPath } = await import('url');
const { execFileSync } = await import('child_process');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(BOT_ROOT, 'data', 'pay-broadcast.json');
const ACTIVITY_FILE = path.join(BOT_ROOT, 'data', 'activity.json');
const ACTIVITY_BACKUP = path.join(BOT_ROOT, 'data', 'activity.json.dryrun-bak');

const ADMIN_QQ = '1365146774';
const GROUP_ID = '860336849';

/* ==================== mock fetch ==================== */

const calls = [];

/**
 * 可变的 mock 状态：同一个进程里要模拟「待审批清单变化」「审批被拒」「缴费单不存在」
 * 等场景，所以这些响应不能写死。
 */
const mock = {
    approvals: [
        { id: 41, amount: 300, payerName: '验收观众', payeeName: '蓦然', payeeType: 'user', kind: 'receive', note: '大额审批用例', createdAt: '2026-09-25 08:00:00' },
        { id: 42, amount: 250, payerName: '张三', payeeName: '联调大额缴费', payeeType: 'event', kind: 'charge_pay', note: '', createdAt: '2026-09-25 08:05:00' },
    ],
    thresholds: { single: 500, daily: 2000, approval: 200 },
    /** 非 null 时 approve 接口直接返回该错误（模拟官网 403/409） */
    approveFail: null,
    /** charge-poster 对这些 token 返回 404「缴费单不存在」 */
    missingPosterTokens: ['MissingPosterToken0001'],
};

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    };
}

globalThis.fetch = async (url, init = {}) => {
    const headers = init.headers || {};
    const auth = headers['X-Bot-Token'] || headers['x-bot-token'] || (headers.get && headers.get('X-Bot-Token'));
    const rec = { url: String(url), method: init.method || 'GET', auth, body: init.body ? String(init.body) : null };
    calls.push(rec);
    const u = rec.url;

    if (u.includes('/api/qqbot/pay/pending-approvals')) {
        return jsonResponse({ ok: true, approvals: mock.approvals, thresholds: mock.thresholds });
    }
    if (u.includes('/api/qqbot/pay/approve/')) {
        if (mock.approveFail) return jsonResponse(mock.approveFail.body, mock.approveFail.status);
        const action = /"action":"reject"/.test(rec.body || '') ? 'reject' : 'approve';
        return jsonResponse({
            ok: true,
            status: action === 'reject' ? 'rejected' : 'success',
            message: action === 'reject' ? '已驳回，款项未划转' : '已通过并完成划转',
        });
    }
    if (u.includes('/api/qqbot/pay/render-url')) {
        return jsonResponse({ ok: true, url: 'https://xuanjian.top/api/pay/render/summary.png?exp=1790000000&sig=abc123', expiresIn: 600 });
    }
    // 注意：必须排在 /api/qqbot/pay/charge 之前（前缀相同）
    if (u.includes('/api/qqbot/pay/charge-poster')) {
        const token = new URL(u).searchParams.get('token') || '';
        if (mock.missingPosterTokens.includes(token)) return jsonResponse({ error: '缴费单不存在' }, 404);
        return jsonResponse({
            ok: true, token, title: '团建费',
            url: `https://xuanjian.top/api/pay/render/charge/${token}.png`,
            pageUrl: `https://xuanjian.top/pay/charge/${token}`,
            stats: { count: 3, paidCount: 1, total: 60, paidSum: 20 },
            deadline: '2026-10-02 16:00:00', expired: false,
        });
    }
    if (u.includes('/api/qqbot/pay/charge')) {
        return jsonResponse({
            ok: true, token: 'CHARGETOKEN1234567890', url: '/pay/charge/CHARGETOKEN1234567890',
            title: '团建费', amount: 20, deadline: '2026-10-02 16:00:00', targetCount: 3, unmatchedQq: [],
        });
    }
    if (u.includes('/api/qqbot/pay/receive-code')) {
        return jsonResponse({
            ok: true, token: 'TESTTOKEN1234567890', url: 'https://xuanjian.top/pay/TESTTOKEN1234567890',
            qrUrl: 'https://xuanjian.top/api/pay/qr.png?text=TESTTOKEN1234567890',
            ttlSeconds: 90, amount: 5, note: '测试备注',
            user: { id: 2, username: 'morzane', nickname: '蓦然' },
        });
    }
    if (u.includes('/api/qqbot/pay/payer-code')) {
        return jsonResponse({
            ok: true, token: 'PAYERTOKEN1234567890', url: 'https://xuanjian.top/pay/PAYERTOKEN1234567890',
            qrUrl: 'https://xuanjian.top/api/pay/qr.png?text=PAYERTOKEN1234567890',
            ttlSeconds: 60, remainSeconds: 58,
            user: { id: 2, username: 'morzane', nickname: '蓦然' },
        });
    }
    if (u.includes('/api/rankings/contribution')) {
        return jsonResponse({ rankings: [{ nickname: '蓦然', contribution: 138.24 }, { nickname: '张三', contribution: 66.6 }] });
    }
    return jsonResponse({ error: `未 mock 的接口：${u}` }, 404);
};

/* ==================== 子进程探针（跨进程：开关缺省值 / 重启不重复播报） ==================== */

/** 子进程环境：不继承干跑进程的 PAY_BROADCAST，由调用方显式指定 */
function childEnv(payBroadcast) {
    const env = {
        ...process.env,
        OFFICIAL_API_BASE: 'https://xuanjian.top',
        OFFICIAL_SITE_BASE: 'https://xuanjian.top',
        OFFICIAL_BOT_TOKEN: 'dryrun-token',
        BROADCAST_GROUP_ID: GROUP_ID,
        APPROVAL_GROUP_ID: GROUP_ID,
    };
    if (payBroadcast === undefined) delete env.PAY_BROADCAST;
    else env.PAY_BROADCAST = payBroadcast;
    return env;
}

function runChild(code, payBroadcast) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: BOT_ROOT, env: childEnv(payBroadcast), encoding: 'utf8',
    });
    return out.trim().split('\n').filter(Boolean).pop();
}

/** 探针：PAY_BROADCAST 取不同值时，startPayBroadcasts 是否建定时器 / 是否请求官网 */
function switchProbe(payBroadcast) {
    const code = `
    const timers = { timeouts: 0, intervals: 0 };
    const rt = globalThis.setTimeout, ri = globalThis.setInterval;
    globalThis.setTimeout = (...a) => { timers.timeouts++; return rt(...a); };
    globalThis.setInterval = (...a) => { timers.intervals++; return ri(...a); };
    let fetches = 0;
    globalThis.fetch = async () => { fetches++; return { ok: true, status: 200, json: async () => ({ ok: true, approvals: [], thresholds: {} }) }; };
    const { config } = await import('./dist/config.js');
    const { startPayBroadcasts } = await import('./dist/services/payBroadcast.js');
    const stop = startPayBroadcasts(async () => {});
    await new Promise((r) => rt(() => r(), 300));
    stop();
    console.log(JSON.stringify({ enabled: config.payBroadcast, ...timers, fetches }));
    `;
    return JSON.parse(runChild(code, payBroadcast));
}

/** 探针：新进程（模拟重启）用同一份 data/pay-broadcast.json 轮询，不应重复播报 */
function restartProbe() {
    const code = `
    const approvals = ${JSON.stringify(mock.approvals)};
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, approvals, thresholds: {} }) });
    const { pollPendingApprovals } = await import('./dist/services/payBroadcast.js');
    let sent = 0;
    const n = await pollPendingApprovals(async () => { sent++; });
    console.log(JSON.stringify({ announced: n, sent }));
    `;
    return JSON.parse(runChild(code, 'on'));
}


/* ==================== 测试框架 ==================== */

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' · ' + extra : ''}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? ' · ' + extra : ''}`); }
};

const { registerAllCommands } = await import('../dist/handlers/commands.js');
const { getCommands } = await import('../dist/core/command.js');
const broadcast = await import('../dist/services/payBroadcast.js');

// 备份/清空本地状态，避免干跑污染真实游标与活跃数据
let activityBackup = null;
if (fs.existsSync(ACTIVITY_FILE)) {
    activityBackup = fs.readFileSync(ACTIVITY_FILE, 'utf8');
    fs.copyFileSync(ACTIVITY_FILE, ACTIVITY_BACKUP);
}
if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

registerAllCommands();
const entries = getCommands();
console.log(`已注册指令 ${entries.length} 条`);

// 新指令不得与既有指令（原 26 条）重名：主名与别名都不能重复
{
    const seen = new Map();
    const dup = [];
    for (const e of entries) {
        for (const n of [e.name, ...(e.aliases || [])]) {
            const k = String(n).toLowerCase();
            if (seen.has(k)) dup.push(`${n}（${seen.get(k)} / ${e.name}）`);
            else seen.set(k, e.name);
        }
    }
    check('指令名/别名无重复', dup.length === 0, dup.join('，') || `${entries.length} 条指令 / ${seen.size} 个关键字`);
    for (const n of ['缴费单', '缴费单图', '审批', '通过', '驳回', '月报']) {
        check(`新指令 ${n} 已注册`, entries.some((e) => e.name === n));
    }
}

const find = (...names) => entries.find((e) => {
    const cands = [e.name, ...(e.aliases || [])].map((x) => String(x).toLowerCase());
    return names.some((n) => cands.includes(n.toLowerCase()));
});

async function run(entry, { userId = ADMIN_QQ, groupId = GROUP_ID, text = '' } = {}) {
    const replies = [];
    const sent = [];
    const baseline = calls.length;
    const ctx = {
        userId, groupId, text,
        isPrivate: !groupId,
        reply: (m) => replies.push(String(m)),
        client: { send: async (action, params) => { sent.push({ action, params }); } },
    };
    await entry.handler(ctx);
    const apiCalls = calls.slice(baseline);
    const segments = sent.flatMap((s) => (Array.isArray(s.params?.message) ? s.params.message : []));
    const images = segments.filter((seg) => seg?.type === 'image').map((seg) => seg.data?.file);
    const sentText = segments.filter((seg) => seg?.type === 'text').map((seg) => String(seg.data?.text || ''));
    // 文案可能走 reply（错误/提示）也可能作为图片消息的文字段（成功路径）
    const allText = [...replies, ...sentText].join(' | ');
    return { replies, sent, apiCalls, images, text: allText };
}

/* ==================== ① 指令干跑 ==================== */

console.log('\n=== 指令干跑 ===');
const cases = [
    { label: '收款码', names: ['收款码', 'shoukuanma', 'qr'], text: '5 测试备注', expectApi: '/api/qqbot/pay/receive-code', expectImage: /\/api\/pay\/qr\.png\?text=/ },
    { label: '付款码', names: ['付款码', 'fukuanma', 'paycode'], text: '', expectApi: '/api/qqbot/pay/payer-code', expectImage: /\/api\/pay\/qr\.png\?text=/ },
    { label: '缴费单', names: ['缴费单', 'jiaofeidan', 'charge'], text: '团建费 20', expectApi: '/api/qqbot/pay/charge', expectImage: /\/api\/pay\/render\/charge\/CHARGETOKEN1234567890\.png$/ },
    { label: '转分', names: ['转分', 'zhuanfen', 'transfer'], text: '[CQ:at,qq=123456789] 50 买材料', expectApi: '/api/qqbot/pay/receive-code', expectImage: /\/api\/pay\/qr\.png\?text=/ },
];

for (const c of cases) {
    const entry = find(...c.names);
    if (!entry) { check(`${c.label} 已注册`, false); continue; }
    check(`${c.label} 已注册`, true, `别名 ${(entry.aliases || []).join('/') || '无'}`);
    const { sent, apiCalls, images, text } = await run(entry, { text: c.text });
    const call = apiCalls[0];
    check(`  ${c.label} 调用 ${c.expectApi}`, !!call && call.url.includes(c.expectApi), call ? call.url.replace('https://xuanjian.top', '') : '未发起请求');
    check(`  ${c.label} 带 X-Bot-Token`, !!call && !!call.auth);
    check(`  ${c.label} 群内发图 send_group_msg`, sent.some((s) => s.action === 'send_group_msg'), sent.map((s) => s.action).join(',') || '无');
    check(`  ${c.label} 图片地址正确`, images.some((u) => c.expectImage.test(String(u))), String(images[0] || '无'));
    check(`  ${c.label} 文案含关键信息`, /收款码|付款码|缴费单|链接|xuanjian\.top/.test(text), text.replace(/\s+/g, ' ').slice(0, 100));
}

// 缴费单：文案保留标题/金额/人数/截止/链接 + 「本人会话确认」
{
    const r = await run(find('缴费单'), { text: '团建费 20' });
    check(
        '缴费单文案含 标题/金额/名单/截止/链接',
        /团建费/.test(r.text) && /20\.00 贡献点\/人/.test(r.text) && /名单：3 人/.test(r.text)
        && /2026-10-02 16:00:00/.test(r.text) && /\/pay\/charge\/CHARGETOKEN/.test(r.text),
    );
    check('缴费单文案含「本人登录的官网会话里确认支付」', /本人登录的官网会话里确认支付/.test(r.text));
    check('缴费单发的是海报图而非二维码接口', r.images.every((u) => String(u).includes('/api/pay/render/charge/')));

    // ① 优先发 charge-poster 返回的 url，并带上缴费进度（催缴用）
    const posterCall = r.apiCalls.find((c) => c.url.includes('/api/qqbot/pay/charge-poster?token='));
    check('缴费单 调 charge-poster 取官方海报', !!posterCall && /token=CHARGETOKEN1234567890/.test(posterCall.url), posterCall ? posterCall.url.replace('https://xuanjian.top', '') : '未调用');
    check('缴费单 charge-poster 带 X-Bot-Token', !!posterCall && !!posterCall.auth);
    check(
        '缴费单 图片就是 charge-poster 返回的 url',
        r.images.some((u) => String(u) === 'https://xuanjian.top/api/pay/render/charge/CHARGETOKEN1234567890.png'),
        String(r.images[0] || '无'),
    );
    check('缴费单 文案含缴费进度（已缴/总额）', /进度：已缴 1\/3 人/.test(r.text) && /20\.00\/60\.00 点/.test(r.text), r.text.replace(/\s+/g, ' ').slice(0, 120));
    check('缴费单 单次创建对官网请求 ≤2（创建 + 海报）', r.apiCalls.length <= 2, `${r.apiCalls.length} 次`);

    // charge-poster 不可用（5xx/网络）时退回公开渲染地址，不影响「已创建」这条信息发出
    const origFetch2 = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/api/qqbot/pay/charge-poster')) return jsonResponse({ error: '获取海报失败' }, 500);
        return origFetch2(url, init);
    };
    const degraded = await run(find('缴费单'), { text: '团建费 20' });
    globalThis.fetch = origFetch2;
    check(
        '缴费单 charge-poster 故障时退回公开渲染地址（不中断）',
        degraded.images.some((u) => String(u).endsWith('/api/pay/render/charge/CHARGETOKEN1234567890.png')) && /缴费单已创建/.test(degraded.text),
        String(degraded.images[0] || '无'),
    );
}

// 缴费单图（链接 / 纯 token / 缺参数 / 不存在）
{
    const byLink = await run(find('缴费单图'), { text: 'https://xuanjian.top/pay/charge/AbCdEfGhIjKlMnOpQrStUv' });
    check(
        '缴费单图（链接）提取 token 并调 charge-poster',
        byLink.apiCalls.some((c) => c.url.includes('/api/qqbot/pay/charge-poster?token=AbCdEfGhIjKlMnOpQrStUv')),
        byLink.apiCalls.map((c) => c.url.replace('https://xuanjian.top', '')).join(' , '),
    );
    check('缴费单图（链接）发海报', byLink.images.some((u) => String(u).endsWith('/api/pay/render/charge/AbCdEfGhIjKlMnOpQrStUv.png')), String(byLink.images[0] || '无'));
    const byToken = await run(find('缴费单图'), { text: 'AbCdEfGhIjKlMnOpQrStUv' });
    check('缴费单图（纯 token）发海报', byToken.images.some((u) => String(u).endsWith('/api/pay/render/charge/AbCdEfGhIjKlMnOpQrStUv.png')));
    check('缴费单图 群内发图并带网页链接', byToken.sent.some((s) => s.action === 'send_group_msg') && /\/pay\/charge\/AbCdEfGhIjKlMnOpQrStUv/.test(byToken.text));
    check('缴费单图 文案含催缴进度/确认支付提示', /进度：已缴 1\/3 人/.test(byToken.text) && /本人登录的官网会话里确认支付/.test(byToken.text), byToken.text.replace(/\s+/g, ' ').slice(0, 110));
    const bad = await run(find('缴费单图'), { text: '没有token' });
    check('缴费单图 参数缺失给用法且不发图', /用法/.test(bad.text) && bad.images.length === 0, bad.text.slice(0, 40));
    const missing = await run(find('缴费单图'), { text: 'MissingPosterToken0001' });
    check('缴费单图 官网 404 时回显文案且不发死图', /缴费单不存在/.test(missing.text) && missing.images.length === 0, missing.text.replace(/\s+/g, ' ').slice(0, 60));
}

// 审批列表
{
    const r = await run(find('审批'), { text: '' });
    const call = r.apiCalls[0];
    check('审批 调 pending-approvals', !!call && call.url.includes('/api/qqbot/pay/pending-approvals'), call ? call.url.replace('https://xuanjian.top', '') : '无');
    check('审批 带 X-Bot-Token', !!call && !!call.auth);
    check('审批 列出条目与操作提示', /#41/.test(r.text) && /#通过 41/.test(r.text) && /#驳回 41/.test(r.text) && /300\.00/.test(r.text), r.text.replace(/\s+/g, ' ').slice(0, 88));
    check('审批 带阈值说明与权限提示', /阈值：单笔 500\.00/.test(r.text) && /非管理员会被拒绝/.test(r.text));

    // 无待审批时要说清楚「没有」，而不是给个空列表
    const saved = mock.approvals;
    mock.approvals = [];
    const empty = await run(find('审批'), { text: '' });
    mock.approvals = saved;
    check('审批 无待审批时明确说明', /当前没有待审批/.test(empty.text), empty.text.slice(0, 40));
    check('审批 别名可用（待审批）', !!find('审批', 'shenpi', 'approvals', '待审批'));
}

// 通过 / 驳回（含别名、请求体、参数缺失）
for (const [names, action, expectMsg] of [
    [['通过', 'tongguo', 'approve', '同意'], 'approve', '已通过并完成划转'],
    [['驳回', 'bohui', 'reject', '拒绝'], 'reject', '已驳回，款项未划转'],
]) {
    const entry = find(...names);
    check(`${names[0]} 已注册`, !!entry, `别名 ${(entry?.aliases || []).join('/')}`);
    const r = await run(entry, { text: '12' });
    const call = r.apiCalls[0];
    check(`  ${names[0]} 调 approve/12`, !!call && call.url.includes('/api/qqbot/pay/approve/12'), call ? call.url.replace('https://xuanjian.top', '') : '无');
    check(`  ${names[0]} 带鉴权头`, !!call && !!call.auth);
    check(
        `  ${names[0]} 请求体 action=${action} 且带 qq`,
        new RegExp(`"action":"${action}"`).test(call?.body || '') && /"qq":"\d+"/.test(call?.body || ''),
        call?.body,
    );
    check(`  ${names[0]} 回显官网文案`, r.text.includes(expectMsg), r.text.slice(0, 40));
    const noId = await run(entry, { text: '' });
    check(`  ${names[0]} 缺 ID 给用法且不请求`, /用法/.test(noId.text) && noId.apiCalls.length === 0);
}

// 通过 / 驳回：官网 403（权限不足）/ 409（重复审批）文案必须原样回显
{
    mock.approveFail = { status: 403, body: { error: '只有管理员可以审批大额支付' } };
    const forbid = await run(find('通过'), { text: '7' });
    check('通过 403 时回显官网权限文案', /通过失败：只有管理员可以审批大额支付/.test(forbid.text), forbid.text.slice(0, 48));
    mock.approveFail = { status: 409, body: { error: '该笔支付已处理，无法重复审批' } };
    const dup = await run(find('驳回'), { text: '7' });
    check('驳回 409 时回显官网重复审批文案', /驳回失败：该笔支付已处理/.test(dup.text), dup.text.slice(0, 48));
    mock.approveFail = { status: 404, body: { error: '该 QQ 尚未绑定官网账号：请先在群里发送 #绑定' } };
    const unbound = await run(find('通过'), { text: '7' });
    check('通过 404（未绑定）时回显官网文案', /通过失败：该 QQ 尚未绑定官网账号/.test(unbound.text), unbound.text.slice(0, 48));
    mock.approveFail = null;
}

// 月报（管理员专用）
{
    const entry = find('月报', 'yuebao', 'monthly');
    check('月报 已注册', !!entry);
    const r = await run(entry, { text: '' });
    check('月报 请求数 ≤3', r.apiCalls.length <= 3, `${r.apiCalls.length} 次`);
    check('月报 调 render-url?kind=summary', r.apiCalls.some((c) => c.url.includes('/api/qqbot/pay/render-url?kind=summary')));
    check('月报 发签名海报图', r.images.some((u) => String(u).includes('/api/pay/render/summary.png?exp=')), String(r.images[0] || '无'));
    check('月报 群内发图', r.sent.some((s) => s.action === 'send_group_msg'));
    check('月报 文案含待审批概述/明细说明/有效期/后台链接', /待审批 2 笔/.test(r.text) && /今日 \/ 近 7 天 \/ 累计/.test(r.text) && /10 分钟内有效/.test(r.text) && /admin#pay/.test(r.text), r.text.replace(/\s+/g, ' ').slice(0, 130));
    const nonAdmin = await run(entry, { text: '', userId: '10000001' });
    check('月报 非管理员被拒且不请求官网', /权限不足/.test(nonAdmin.text) && nonAdmin.apiCalls.length === 0);
}

/* ==================== ② 播报服务干跑 ==================== */

console.log('\n=== 播报服务 ===');
{
    const sentBox = [];
    const sender = async (groupId, message) => { sentBox.push({ groupId, message }); };

    const n1 = await broadcast.pollPendingApprovals(sender);
    check('轮询：首次播报新增待审批', n1 === 2, `${n1} 笔`);
    check('轮询：发到 APPROVAL_GROUP_ID', sentBox[0]?.groupId === Number(GROUP_ID), String(sentBox[0]?.groupId));
    const text1 = JSON.stringify(sentBox[0]?.message || []);
    check('轮询：文案含金额与通过/驳回用法', /300\.00/.test(text1) && /#通过 41/.test(text1) && /#驳回 42/.test(text1));
    check('轮询：游标已持久化', fs.existsSync(STATE_FILE) && /41/.test(fs.readFileSync(STATE_FILE, 'utf8')));

    const n2 = await broadcast.pollPendingApprovals(sender);
    check('轮询：同一批不重复播报', n2 === 0 && sentBox.length === 1);

    // 游标只增不减：审批暂时离开列表（已被处理 / 列表抖动）后再出现，也不重复播报
    const savedApprovals = mock.approvals;
    mock.approvals = [];
    const n3 = await broadcast.pollPendingApprovals(sender);
    mock.approvals = savedApprovals;
    const n4 = await broadcast.pollPendingApprovals(sender);
    check('轮询：已播报 ID 离开列表再出现也不重复播报', n3 === 0 && n4 === 0 && sentBox.length === 1, `n3=${n3} n4=${n4} 发送=${sentBox.length}`);

    // 重启（新进程读同一份 data/pay-broadcast.json）后同样不重复播报
    const restart = restartProbe();
    check('轮询：重启后不重复播报（游标来自 data/*.json）', restart.announced === 0 && restart.sent === 0, JSON.stringify(restart));

    // 失败退避：fetch 抛错时静默返回 0，且退避期内不再请求（不刷日志、不抛异常）
    const origFetch = globalThis.fetch;
    let failedAttempts = 0;
    globalThis.fetch = async () => { failedAttempts++; throw new Error('network down'); };
    const f1 = await broadcast.pollPendingApprovals(sender);
    const f2 = await broadcast.pollPendingApprovals(sender);
    check('轮询：失败静默退避（不抛异常、退避期不重试）', f1 === 0 && f2 === 0 && failedAttempts === 1 && sentBox.length === 1, `实际请求 ${failedAttempts} 次`);
    globalThis.fetch = origFetch;
}

{
    const weekly = await broadcast.buildWeeklyReport(GROUP_ID);
    check('周报：含标题与统计范围', /【本周群周报】/.test(weekly) && /最近 7 天/.test(weekly), weekly.replace(/\s+/g, ' ').slice(0, 70));
    check('周报：含贡献榜 Top（官网数据）', /贡献点 Top5/.test(weekly) && /蓦然/.test(weekly));
}

{
    const sentBox = [];
    const sender = async (groupId, message) => { sentBox.push({ groupId, message }); };
    // 2026-10-01 02:00 UTC = 上海 10:00 → 月报触发一次
    const monthlyTs = Date.parse('2026-10-01T02:00:00Z');
    const before = calls.length;
    await broadcast.tickScheduledJobs(sender, monthlyTs);
    const firstRunCalls = calls.length - before;
    check('定时：每月 1 日 10:00（上海）触发月报', sentBox.length === 1 && sentBox[0].groupId === Number(GROUP_ID), `发送 ${sentBox.length} 次`);
    check('定时：单次播报请求数 ≤3', firstRunCalls <= 3, `${firstRunCalls} 次`);
    check('定时：月报发的是签名海报图', /summary\.png\?exp=/.test(JSON.stringify(sentBox[0]?.message || [])));
    await broadcast.tickScheduledJobs(sender, monthlyTs + 60_000);
    check('定时：同一周期不重复触发', sentBox.length === 1);
    // 2026-10-05（周一）01:00 UTC = 上海 09:00 → 周报触发
    const weeklyTs = Date.parse('2026-10-05T01:00:00Z');
    await broadcast.tickScheduledJobs(sender, weeklyTs);
    check('定时：每周一 09:00（上海）触发文字周报', sentBox.length === 2 && /本周群周报/.test(JSON.stringify(sentBox[1].message)));
    await broadcast.tickScheduledJobs(sender, Date.parse('2026-10-06T01:00:00Z'));
    check('定时：非触发日不发送', sentBox.length === 2);
    // 定时播报里没有图片段（周报纯文字）
    check('定时：周报为纯文字（无图片段）', !/image/.test(JSON.stringify(sentBox[1]?.message || [])));
}

/* ==================== ③ 关开关与边界 ==================== */

console.log('\n=== 开关与边界 ===');
{
    // 子进程探针：不继承本进程的 PAY_BROADCAST，验证「缺省 off」是真的不轮询、不定时报
    const off = switchProbe(undefined);
    check(
        'PAY_BROADCAST 缺省（未设置）= off：不建定时器、不请求官网',
        off.enabled === false && off.timeouts === 0 && off.intervals === 0 && off.fetches === 0,
        JSON.stringify(off),
    );
    const offExplicit = switchProbe('off');
    check('PAY_BROADCAST=off：同样不建定时器', offExplicit.enabled === false && offExplicit.timeouts === 0 && offExplicit.intervals === 0, JSON.stringify(offExplicit));
    const on = switchProbe('on');
    check(
        'PAY_BROADCAST=on：建立待审批轮询 + 定时检查（1 个 kickoff + 2 个 interval）',
        on.enabled === true && on.timeouts === 1 && on.intervals === 2,
        JSON.stringify(on),
    );
}
{
    // 本进程 PAY_BROADCAST=on：startPayBroadcasts 返回可停止的句柄
    const stop = broadcast.startPayBroadcasts(async () => {});
    check('startPayBroadcasts 返回 stop 函数', typeof stop === 'function');
    stop();
}
{
    const rc = find('收款码');
    const r = await run(rc, { userId: '', groupId: '', text: '5' });
    check('无 QQ 号时提示私聊且不请求官网', /QQ|私聊/.test(r.text) && r.apiCalls.length === 0, r.text.slice(0, 40));

    const charge = find('缴费单');
    const c = await run(charge, { text: '' });
    check('缴费单缺参数时给用法', /用法|例如|请填写/.test(c.text), c.text.replace(/\s+/g, ' ').slice(0, 56));
}

/* ==================== 清理本地状态 ==================== */

if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
if (activityBackup !== null) fs.writeFileSync(ACTIVITY_FILE, activityBackup, 'utf8');
if (fs.existsSync(ACTIVITY_BACKUP)) fs.unlinkSync(ACTIVITY_BACKUP);
console.log('\n（已清理干跑产生的 data/pay-broadcast.json 与临时备份）');

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
