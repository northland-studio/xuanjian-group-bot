/**
 * 机器人干跑脚本（不发真实消息、不碰生产数据）
 * 用法：cd xuanjian-group-bot && npm run build && node scripts/dryrun-pay.mjs
 *
 * 覆盖：
 *  - 指令注册/别名去重、请求 URL、X-Bot-Token 鉴权头、群内发图调用、回复文案
 *  - 缴费单改发 charge-poster 海报图（含进度/催缴文案与故障降级）、缴费单图（token/链接/不存在）
 *  - 审批 / 通过 / 驳回（含官网 403/409/404 文案回显）、月报（签名链接）
 *  - 播报服务：待审批轮询去重（游标持久化 + 重启不重复）、失败静默退避、月报/周报内容组装、定时任务到点只触发一次
 *  - 开关：PAY_BROADCAST 缺省 off（子进程探针验证不建定时器、不请求官网）
 *  - #help 图片输出：官网 help-card 请求 URL/鉴权头/body 结构（分组上限与指令清单来自注册表）、
 *    图片本体下载到本地 data/help-cards/ 并发本地文件（下载失败退回在线地址）、
 *    进程内+落盘缓存、本地图丢失自动补下、#help 刷新 / #指令图 强制重生成、
 *    官网故障与发图失败时的文字列表回退、/help 与 help/帮助/菜单 兼容
 *  - 迎新词：#迎新 查看/设置/开关/@/测试/重置（含别名指令）的权限与存储行为、
 *    超长拒绝、每群一份配置、模板变量替换与降级、入群事件消息组装（关闭时不发）
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
const HELP_CACHE_FILE = path.join(BOT_ROOT, 'data', 'help-card.json');
const HELP_IMAGE_DIR = path.join(BOT_ROOT, 'data', 'help-cards');
const WELCOME_FILE = path.join(BOT_ROOT, 'data', 'welcome.json');
const WELCOME_BACKUP = path.join(BOT_ROOT, 'data', 'welcome.json.dryrun-bak');

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
    /** help-card：非 null 时直接返回该错误（模拟官网 400/500） */
    helpCardFail: null,
    /** help-card 成功次数（每次生成不同 hash/url，用来验证刷新确实重新生成） */
    helpCardSeq: 0,
    /** help-card 返回的 expiresIn（null = 官网不设有效期） */
    helpCardExpiresIn: null,
    /** 图片本体（/api/render/help/*.png）是否下载失败：模拟官网渲染 502 */
    helpImageFail: false,
    /** 图片本体被请求的次数：验证「只下一次，之后走本地文件」 */
    helpImageFetches: 0,
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

/** 假的 PNG 响应（带 PNG magic，够大以通过机器人的有效性校验） */
function pngResponse(bytes = 4096) {
    const buf = Buffer.alloc(bytes, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
    return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/png']]),
        arrayBuffer: async () => buf,
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
    // 帮助图本体：机器人会把它下载到 data/help-cards/，之后 #help 直接发本地文件
    if (u.includes('/api/render/help/')) {
        mock.helpImageFetches += 1;
        if (mock.helpImageFail) {
            return { ok: false, status: 502, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
        }
        return pngResponse();
    }
    // 指令帮助图：每次成功都换一个 hash/url，便于断言「缓存复用」与「刷新重生」
    if (u.includes('/api/qqbot/pay/help-card')) {
        if (mock.helpCardFail) return jsonResponse(mock.helpCardFail.body, mock.helpCardFail.status);
        mock.helpCardSeq += 1;
        const hash = `hash${mock.helpCardSeq}`;
        let count = 0;
        try {
            count = (JSON.parse(rec.body || '{}').groups || []).reduce((n, g) => n + (g.items?.length || 0), 0);
        } catch { /* body 不是 JSON 时按 0 记 */ }
        return jsonResponse({
            ok: true,
            url: `https://xuanjian.top/api/render/help/${hash}.png`,
            hash,
            count,
            expiresIn: mock.helpCardExpiresIn,
        });
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
const { getCommands, parseCommand } = await import('../dist/core/command.js');
const broadcast = await import('../dist/services/payBroadcast.js');
const helpCard = await import('../dist/services/helpCard.js');
const welcome = await import('../dist/services/welcome.js');

// 备份/清空本地状态，避免干跑污染真实游标、活跃数据、帮助图缓存与迎新词配置
let activityBackup = null;
if (fs.existsSync(ACTIVITY_FILE)) {
    activityBackup = fs.readFileSync(ACTIVITY_FILE, 'utf8');
    fs.copyFileSync(ACTIVITY_FILE, ACTIVITY_BACKUP);
}
if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
let welcomeBackup = null;
if (fs.existsSync(WELCOME_FILE)) {
    welcomeBackup = fs.readFileSync(WELCOME_FILE, 'utf8');
    fs.copyFileSync(WELCOME_FILE, WELCOME_BACKUP);
    fs.unlinkSync(WELCOME_FILE);
}
if (fs.existsSync(HELP_CACHE_FILE)) fs.unlinkSync(HELP_CACHE_FILE);
// 帮助图本地缓存目录也清干净，保证干跑从「本地没有图」开始
fs.rmSync(HELP_IMAGE_DIR, { recursive: true, force: true });

registerAllCommands();
const entries = getCommands();
console.log(`已注册指令 ${entries.length} 条`);

// 新增指令不得与既有指令重名：主名与别名都不能重复
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
    for (const n of ['help', '指令图', '迎新', '欢迎查看', '设置迎新', '迎新开关']) {
        check(`新指令 ${n} 已注册`, entries.some((e) => e.name === n));
    }
    const helpAliases = entries.find((e) => e.name === 'help')?.aliases || [];
    for (const n of ['帮助', '菜单']) {
        check(`help 兼容别名 ${n} 保留`, helpAliases.includes(n));
    }
}

const find = (...names) => entries.find((e) => {
    const cands = [e.name, ...(e.aliases || [])].map((x) => String(x).toLowerCase());
    return names.some((n) => cands.includes(n.toLowerCase()));
});

async function run(entry, { userId = ADMIN_QQ, groupId = GROUP_ID, text = '', clientSendThrows = false } = {}) {
    const replies = [];
    const sent = [];
    const baseline = calls.length;
    const ctx = {
        userId, groupId, text,
        isPrivate: !groupId,
        reply: (m) => replies.push(String(m)),
        client: {
            send: async (action, params) => {
                if (clientSendThrows) throw new Error('napcat send failed');
                sent.push({ action, params });
            },
        },
    };
    await entry.handler(ctx);
    const apiCalls = calls.slice(baseline);
    const segments = sent.flatMap((s) => (Array.isArray(s.params?.message) ? s.params.message : []));
    const images = segments.filter((seg) => seg?.type === 'image').map((seg) => seg.data?.file);
    const sentText = segments.filter((seg) => seg?.type === 'text').map((seg) => String(seg.data?.text || ''));
    // 文案可能走 reply（错误/提示）也可能作为图片消息的文字段（成功路径）
    const allText = [...replies, ...sentText].join(' | ');
    return { replies, sent, segments, apiCalls, images, text: allText };
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

/* ==================== ④ #help 图片输出 ==================== */

console.log('\n=== ④ #help 图片输出 ===');
{
    const helpEntry = find('help');
    check('help 已注册且保留原别名 帮助/菜单', !!helpEntry, (helpEntry?.aliases || []).join('/'));
    check('指令图 已注册（等价 #help 刷新）', !!find('指令图', 'helpimg'));

    // 前缀兼容：# 、/ 、私聊不带前缀
    check('/help 前缀兼容', parseCommand('/help', false)?.entry?.name === 'help');
    check('#help 前缀兼容', parseCommand('#help', false)?.entry?.name === 'help');
    check('#help 刷新 参数解析', parseCommand('#help 刷新', false)?.args === '刷新');
    check('群聊无前缀不触发（保持原行为）', parseCommand('help', false) === null);
    check('私聊不带前缀可用 help', parseCommand('帮助', true)?.entry?.name === 'help');

    const r1 = await run(helpEntry, { text: '' });
    const call = r1.apiCalls.find((c) => c.url.includes('/api/qqbot/pay/help-card'));
    check('help 调 POST /api/qqbot/pay/help-card', !!call && call.method === 'POST', call ? call.url.replace('https://xuanjian.top', '') : '未发起请求');
    // 线上真实路径带 /pay（曾误写成 /api/qqbot/help-card，生产 404 却因为 mock 太宽而没被测出来）
    check(
        'help 请求路径与线上一致（/api/qqbot/pay/help-card）',
        !!call && new URL(call.url).pathname === '/api/qqbot/pay/help-card',
        call ? new URL(call.url).pathname : '无',
    );
    check('help 不带 /pay 的旧路径已无任何请求', r1.apiCalls.every((c) => !/\/api\/qqbot\/help-card/.test(c.url)));
    check('help 带 X-Bot-Token', !!call && !!call.auth);

    const body = call ? JSON.parse(call.body || '{}') : {};
    check('help 请求体 title', body.title === '玄剑公会群机器人 · 指令总览', String(body.title));
    check(
        'help 请求体 subtitle 含条数与前缀',
        body.subtitle === `共 ${entries.length} 条指令 · 前缀 # 或 /`,
        String(body.subtitle),
    );
    check(
        'help 请求体 groups ≤12 组、每组 items ≤40 条',
        Array.isArray(body.groups) && body.groups.length > 0 && body.groups.length <= 12
        && body.groups.every((g) => Array.isArray(g.items) && g.items.length > 0 && g.items.length <= 40),
        `${body.groups?.length} 组 / 最多 ${Math.max(...(body.groups || [{ items: [] }]).map((g) => g.items.length))} 条`,
    );
    check(
        'help 请求体 name ≤12 字、desc ≤40 字',
        body.groups.every((g) => [...g.name].length <= 12
            && g.items.every((it) => [...String(it.name)].length <= 12 && [...String(it.desc)].length <= 40)),
    );
    check(
        'help 请求体 items 含 name/aliases/desc',
        body.groups.every((g) => g.items.every((it) => typeof it.name === 'string' && Array.isArray(it.aliases) && typeof it.desc === 'string')),
    );
    check('help 请求体含别名（如 帮助/菜单）', body.groups.some((g) => g.items.some((it) => it.name === 'help' && it.aliases.includes('帮助') && it.aliases.includes('菜单'))));
    check('help 请求体 ≤200KB', Buffer.byteLength(call?.body || '') <= 200 * 1024, `${Buffer.byteLength(call?.body || '')} 字节`);

    const itemNames = body.groups.flatMap((g) => g.items.map((it) => it.name));
    check(
        'help 指令清单来自 getCommands()（不硬编码）',
        itemNames.length === entries.length && entries.every((e) => itemNames.includes(e.name)),
        `图上 ${itemNames.length} 条 / 注册表 ${entries.length} 条`,
    );

    check('help 群内发图 send_group_msg', r1.sent.some((s) => s.action === 'send_group_msg'));
    // 本地图片缓存：官网渲染的 PNG 落到 data/help-cards/，发的是本地文件而不是在线地址
    const localImage1 = path.join(HELP_IMAGE_DIR, 'hash1.png');
    check(
        'help 发的是本地文件（file:// 绝对路径）',
        r1.images.some((u) => String(u).startsWith('file://') && String(u).endsWith('/help-cards/hash1.png')),
        String(r1.images[0] || '无'),
    );
    check(
        'help 图片已下载到 data/help-cards/hash1.png',
        fs.existsSync(localImage1) && fs.statSync(localImage1).size > 100,
        fs.existsSync(localImage1) ? `${fs.statSync(localImage1).size} 字节` : '文件不存在',
    );
    check('help 图片本体只下载 1 次', mock.helpImageFetches === 1, `${mock.helpImageFetches} 次`);
    check(
        'help 短文案「共 N 条指令，前缀 # 或 /」',
        new RegExp(`共 ${entries.length} 条指令，前缀 # 或 /`).test(r1.text),
        r1.text.replace(/\s+/g, ' ').slice(0, 60),
    );

    // 缓存：同一份指令清单不再请求官网，直接复用 url + 本地文件
    const r2 = await run(helpEntry, { text: '' });
    check('help 第二次命中缓存（0 次官网请求）', r2.apiCalls.length === 0 && r2.images.some((u) => String(u).includes('hash1.png')), `${r2.apiCalls.length} 次请求`);
    check('help 缓存命中仍发本地文件', r2.images.some((u) => String(u).startsWith('file://')), String(r2.images[0] || '无'));
    check('help 缓存命中不重新下载图片', mock.helpImageFetches === 1, `${mock.helpImageFetches} 次`);
    check(
        'help 缓存落盘 data/help-card.json（含 url + hash）',
        fs.existsSync(HELP_CACHE_FILE) && /"hash":\s*"hash1"/.test(fs.readFileSync(HELP_CACHE_FILE, 'utf8')),
        fs.existsSync(HELP_CACHE_FILE) ? fs.readFileSync(HELP_CACHE_FILE, 'utf8').replace(/\s+/g, ' ').slice(0, 70) : '无缓存文件',
    );
    check(
        'help 缓存记录了本地图片路径（localPath）',
        /"localPath":\s*"[^"]*help-cards/.test(fs.readFileSync(HELP_CACHE_FILE, 'utf8')),
        '帮助图升级后不必等指令变化就能用上本地文件',
    );

    // 本地图片被删/迁移丢失 → 用缓存里的 url 自动补下，不需要重新 POST help-card
    fs.unlinkSync(localImage1);
    const r2b = await run(helpEntry, { text: '' });
    check(
        'help 本地图丢失 → 自动重下（不再 POST help-card）',
        r2b.apiCalls.length === 1
        && r2b.apiCalls[0].url.includes('/api/render/help/hash1.png')
        && r2b.images.some((u) => String(u).startsWith('file://')),
        r2b.apiCalls.map((c) => c.url.replace('https://xuanjian.top', '')).join(' , ') || '无请求',
    );
    check('help 重下后本地文件恢复', fs.existsSync(localImage1) && fs.statSync(localImage1).size > 100);

    // 刷新：强制重新生成（官网换 hash/url）
    mock.helpCardExpiresIn = 600;
    const r3 = await run(helpEntry, { text: '刷新' });
    check(
        'help 刷新 强制重新生成',
        r3.apiCalls.some((c) => c.url.includes('/api/qqbot/pay/help-card')) && r3.images.some((u) => String(u).includes('hash2.png')),
        String(r3.images[0] || '无'),
    );
    check('help expiresIn 落盘为 expiresAt', /"expiresAt":\s*\d+/.test(fs.readFileSync(HELP_CACHE_FILE, 'utf8')));
    const r4 = await run(find('指令图'), { text: '' });
    check(
        '#指令图 = 强制刷新',
        r4.apiCalls.some((c) => c.url.includes('/api/qqbot/pay/help-card')) && r4.images.some((u) => String(u).includes('hash3.png')),
        String(r4.images[0] || '无'),
    );
    check('help 刷新后再次缓存命中', (await run(helpEntry, { text: '' })).apiCalls.length === 0);
    mock.helpCardExpiresIn = null;

    // 刷新失败但旧图还在 → 继续用旧图（比回退文字更好），且不抛异常
    mock.helpCardFail = { status: 500, body: { error: '渲染服务不可用' } };
    const stale = await run(helpEntry, { text: '刷新' });
    check(
        'help 官网 500 + 有缓存 → 仍发旧图（不降级文字）',
        stale.apiCalls.length === 1 && stale.images.some((u) => String(u).includes('hash3.png')),
        String(stale.images[0] || '无'),
    );

    // 官网故障 + 无缓存 → 回退原文字列表（格式与改造前一致）
    helpCard.clearHelpCardCache();
    if (fs.existsSync(HELP_CACHE_FILE)) fs.unlinkSync(HELP_CACHE_FILE);
    const fallback = await run(helpEntry, { text: '' });
    check(
        'help 官网故障且无缓存 → 回退文字列表',
        fallback.images.length === 0
        && /玄剑公会群机器人指令：/.test(fallback.text)
        && /注：查询\/核销等敏感操作请私聊机器人。/.test(fallback.text),
        fallback.text.replace(/\s+/g, ' ').slice(0, 60),
    );
    check(
        'help 回退文字含全部指令（#名称 — 描述）',
        entries.every((e) => fallback.text.includes(`#${e.name} — `)),
        `${entries.length} 条`,
    );
    check('help 回退时不发图（sends 为空）', fallback.sent.length === 0);
    mock.helpCardFail = null;

    // 官网正常但 NapCat 发图失败 → 同样回退文字
    const imgFail = await run(helpEntry, { text: '', clientSendThrows: true });
    check(
        'help 发图失败 → 回退文字列表',
        imgFail.images.length === 0 && /玄剑公会群机器人指令：/.test(imgFail.text),
        imgFail.text.slice(0, 40),
    );

    // 图片本体下载失败（官网 render 502）→ 退回在线地址，照样出图（不降级文字）
    mock.helpImageFail = true;
    const noLocal = await run(helpEntry, { text: '刷新' });
    mock.helpImageFail = false;
    check(
        'help 图片下载失败 → 退回在线地址',
        noLocal.images.some((u) => String(u) === 'https://xuanjian.top/api/render/help/hash5.png'),
        String(noLocal.images[0] || '无'),
    );
    check('help 下载失败时不留坏文件', !fs.existsSync(path.join(HELP_IMAGE_DIR, 'hash5.png')));

    // 分组规则：稳定、可读，抽样命中预期分组
    const groupsA = helpCard.buildHelpCardGroups();
    const groupsB = helpCard.buildHelpCardGroups();
    check('help 分组稳定（两次构建完全一致）', JSON.stringify(groupsA) === JSON.stringify(groupsB));
    const groupOf = (name) => groupsA.find((g) => g.items.some((it) => it.name === name))?.name;
    check('help 分组抽样：help/指令图 → 帮助与菜单', groupOf('help') === '帮助与菜单' && groupOf('指令图') === '帮助与菜单', String(groupOf('help')));
    check('help 分组抽样：档案/查自己 → 成员与档案', groupOf('档案') === '成员与档案' && groupOf('查自己') === '成员与档案');
    check('help 分组抽样：收款码/缴费单/审批 → 支付与缴费', groupOf('收款码') === '支付与缴费' && groupOf('缴费单') === '支付与缴费' && groupOf('审批') === '支付与缴费');
    check('help 分组抽样：迎新/迎新开关 → 群管理', groupOf('迎新') === '群管理' && groupOf('迎新开关') === '群管理');
    check('help 分组抽样：核销/任务码 → 核销与任务', groupOf('核销') === '核销与任务' && groupOf('任务码') === '核销与任务');
    check(
        'help 分组可读（组数 ≥5、组名 ≤12 字、无空组）',
        groupsA.length >= 5 && groupsA.every((g) => [...g.name].length <= 12 && g.items.length > 0),
        groupsA.map((g) => `${g.name}(${g.items.length})`).join(' '),
    );
}

/* ==================== ⑤ 迎新词（管理指令） ==================== */

console.log('\n=== ⑤ 迎新词 ===');
{
    const welcomeEntry = find('迎新', 'yingxin', '迎新词');
    const viewEntry = find('欢迎查看');
    const setEntry = find('设置迎新');
    const switchEntry = find('迎新开关');
    check('迎新 指令族已注册（迎新/欢迎查看/设置迎新/迎新开关）', !!welcomeEntry && !!viewEntry && !!setEntry && !!switchEntry);
    check(
        '迎新 别名可用（yingxin/迎新词）',
        parseCommand('#迎新词 查看', false)?.entry?.name === '迎新' && parseCommand('#yingxin 查看', false)?.entry?.name === '迎新',
    );

    // 默认配置
    {
        const def = welcome.getWelcomeConfig(GROUP_ID);
        check('迎新 默认：开启 + @新人 + 无自定义文案', def.enabled === true && def.mention === true && def.text === undefined);
        check(
            '迎新 默认文案为纯文本（无 <b> 等无效标签、含换行）',
            !/<\/?[a-zA-Z][^>]*>/.test(welcome.DEFAULT_WELCOME_TEXT) && welcome.DEFAULT_WELCOME_TEXT.includes('\n'),
            JSON.stringify(welcome.DEFAULT_WELCOME_TEXT).slice(0, 70),
        );
    }

    // 权限：全部子指令 / 别名指令都只能管理员用
    {
        const before = fs.existsSync(WELCOME_FILE) ? fs.readFileSync(WELCOME_FILE, 'utf8') : null;
        const cases = [
            ['迎新 查看', welcomeEntry, '查看'],
            ['迎新 设置', welcomeEntry, '设置 你好'],
            ['迎新 开关', welcomeEntry, '开关 off'],
            ['迎新 测试', welcomeEntry, '测试'],
            ['迎新 重置', welcomeEntry, '重置'],
            ['欢迎查看', viewEntry, ''],
            ['设置迎新', setEntry, '你好'],
            ['迎新开关', switchEntry, 'on'],
        ];
        for (const [label, entry, text] of cases) {
            const r = await run(entry, { text, userId: '10000001' });
            check(`迎新 非管理员「${label}」被拒且不发消息`, /权限不足/.test(r.text) && r.sent.length === 0, r.text.slice(0, 18));
        }
        const after = fs.existsSync(WELCOME_FILE) ? fs.readFileSync(WELCOME_FILE, 'utf8') : null;
        check('迎新 非管理员操作未写盘', after === before);
    }

    // 设置 / 存储结构
    {
        const r = await run(welcomeEntry, { text: '设置 欢迎{at}加入！{换行}第二行' });
        check('迎新 设置 成功并回显字数', /已保存本群迎新词（\d+ 字/.test(r.text), r.text.replace(/\s+/g, ' ').slice(0, 50));
        const store = JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8'));
        const g = store.groups[GROUP_ID];
        check('迎新 存储结构：每群一份 {enabled, mention, text}', !!g && g.enabled === true && g.mention === true && typeof g.text === 'string', JSON.stringify(store.groups && Object.keys(store.groups)));
        check('迎新 存储文案原样保存（变量不展开）', g.text === '欢迎{at}加入！{换行}第二行');
        check('迎新 存储记录更新人/时间', g.updatedBy === ADMIN_QQ && !!g.updatedAt);

        // 多种换行写法：真实换行、字面 \n
        await run(welcomeEntry, { text: '设置 第一行\n第二行' });
        check('迎新 设置 保留真实换行（多行文本）', JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).groups[GROUP_ID].text === '第一行\n第二行');
        await run(setEntry, { text: '甲\\n乙' });
        check('迎新 设置 支持字面 \\n（别名指令 设置迎新）', JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).groups[GROUP_ID].text === '甲\n乙');
        check('指令解析保留多行参数（迎新多行文案）', parseCommand('#迎新 设置 第一行\n第二行', false)?.args === '设置 第一行\n第二行');
    }

    // 查看（含超长分片）
    {
        const longText = '长'.repeat(400);
        await run(welcomeEntry, { text: `设置 ${longText}` });
        const r = await run(welcomeEntry, { text: '查看' });
        check(
            '迎新 查看 显示状态/@/文案来源/变量表',
            /状态：已开启/.test(r.text) && /@新人：是/.test(r.text) && /文案：自定义（400 字 \/ 上限 500）/.test(r.text) && /\{at\} \{昵称\} \{群名\} \{人数\} \{时间\} \{换行\}/.test(r.text),
            r.text.replace(/\s+/g, ' ').slice(0, 80),
        );
        check('迎新 查看 很长时分片发送', r.replies.length >= 2, `${r.replies.length} 条`);
        const byAlias = await run(viewEntry, { text: '' });
        check('迎新 查看 别名指令可用', /状态：/.test(byAlias.text) && /文案：自定义/.test(byAlias.text));
    }

    // 超长拒绝
    {
        const before = JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).groups[GROUP_ID].text;
        const r = await run(welcomeEntry, { text: `设置 ${'超'.repeat(501)}` });
        check('迎新 设置 >500 字被拒绝并提示', /501 字/.test(r.text) && /最多 500 字/.test(r.text), r.text.slice(0, 46));
        check('迎新 超长被拒后不改写存储', JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).groups[GROUP_ID].text === before);
        const empty = await run(welcomeEntry, { text: '设置 ' });
        check('迎新 设置空文本被拒并给用法', /不能为空|用法/.test(empty.text), empty.text.slice(0, 30));
    }

    // 开关 / @
    {
        const off = await run(welcomeEntry, { text: '开关 off' });
        check('迎新 开关 off 落库', welcome.getWelcomeConfig(GROUP_ID).enabled === false && /已关闭/.test(off.text), off.text.slice(0, 20));
        const on = await run(switchEntry, { text: 'on' });
        check('迎新开关（别名指令）on 落库', welcome.getWelcomeConfig(GROUP_ID).enabled === true && /已开启/.test(on.text));
        const bad = await run(welcomeEntry, { text: '开关 也许' });
        check('迎新 开关 参数非法给用法', /用法/.test(bad.text), bad.text.slice(0, 30));
        const mOff = await run(welcomeEntry, { text: '@ off' });
        check('迎新 @ off 落库（mention=false）', welcome.getWelcomeConfig(GROUP_ID).mention === false && /不会 @ 新人/.test(mOff.text), mOff.text.slice(0, 24));
        await run(welcomeEntry, { text: '@ on' });
        check('迎新 @ on 落库', welcome.getWelcomeConfig(GROUP_ID).mention === true);
    }

    // 测试
    {
        const r = await run(welcomeEntry, { text: '测试' });
        check(
            '迎新 测试 在群里发一条并标明「测试」',
            r.sent.some((s) => s.action === 'send_group_msg') && /【测试】/.test(r.text) && /未真实 @ 新人/.test(r.text),
            r.text.replace(/\s+/g, ' ').slice(0, 50),
        );
        check('迎新 测试 不 @ 真实新人（无 at 段）', !r.segments.some((s) => s.type === 'at'), r.segments.map((s) => s.type).join(','));
        const custom = await run(welcomeEntry, { text: '测试 临时文案 {at}{昵称}' });
        check('迎新 测试 [文本] 用临时文案且不落库', /临时文案/.test(custom.text) && JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).groups[GROUP_ID].text !== '临时文案 {at}{昵称}');
        await run(welcomeEntry, { text: '开关 off' });
        check('迎新 关闭状态下仍可测试预览', /【测试】/.test((await run(welcomeEntry, { text: '测试' })).text));
        await run(welcomeEntry, { text: '开关 on' });
    }

    // 重置
    {
        const r = await run(welcomeEntry, { text: '重置' });
        const cfg = welcome.getWelcomeConfig(GROUP_ID);
        check('迎新 重置 清空自定义回到默认', cfg.text === undefined && /默认文案/.test(r.text), r.text.replace(/\s+/g, ' ').slice(0, 40));
        check('迎新 重置 保留开关与 @ 设置', cfg.enabled === true && cfg.mention === true);
        check('迎新 重置后存储不再有 text 字段', JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8')).groups[GROUP_ID].text === undefined);
    }

    // 每群一份配置
    {
        await run(welcomeEntry, { text: '设置 群A专属文案', groupId: GROUP_ID });
        const other = await run(welcomeEntry, { text: '查看', groupId: '999888777' });
        check('迎新 每群一份配置（B 群不受 A 群影响）', /文案：默认/.test(other.text) && !/群A专属文案/.test(other.text), other.text.replace(/\s+/g, ' ').slice(0, 40));
        const store = JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8'));
        check('迎新 存储中两群各自独立', store.groups[GROUP_ID].text === '群A专属文案' && store.groups['999888777'] === undefined);
        await run(welcomeEntry, { text: '重置' });
    }

    // 模板变量（纯函数）
    {
        const rendered = welcome.renderWelcomeText('{昵称}|{群名}|{人数}', { qq: '12345', nickname: '小明', groupName: '玄剑', memberCount: 42 });
        check('迎新 变量 {昵称}/{群名}/{人数} 替换', rendered === '小明|玄剑|42', rendered);
        const timed = welcome.renderWelcomeText('{时间}', {});
        check('迎新 变量 {时间} 为上海时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(timed), timed);
        check('迎新 变量 {换行} 变真实换行', welcome.renderWelcomeText('甲{换行}乙', {}) === '甲\n乙');
        check('迎新 未知变量原样保留（便于发现拼写错误）', welcome.renderWelcomeText('{未知}', {}) === '{未知}');
        check('迎新 取不到昵称时用 QQ 兜底', /QQ 12345/.test(welcome.buildWelcomeSegments('欢迎 {昵称}', { qq: '12345' }, { mention: false }).text));

        const on = welcome.buildWelcomeSegments('欢迎{at}加入', { qq: '22334455', nickname: '新人甲' }, { mention: true });
        check(
            '迎新 {at} 生成真实 at 消息段',
            on.mentioned === true && on.segments.some((s) => s.type === 'at' && String(s.data.qq) === '22334455'),
            on.text.replace(/\n/g, ' '),
        );
        const off = welcome.buildWelcomeSegments('欢迎{at}加入', { qq: '22334455' }, { mention: false });
        check(
            '迎新 mention=false 时不 @（{at} 被删掉）',
            !off.segments.some((s) => s.type === 'at') && off.text === '欢迎加入',
            JSON.stringify(off.text),
        );
        check('迎新 渲染后无残留变量', !/\{(at|昵称|群名|人数|时间|换行)\}/.test(on.text + off.text));
    }

    // 入群事件：组装 + 关闭时不发 + NapCat 取信息失败时降级
    {
        await run(welcomeEntry, { text: '设置 欢迎{at}{昵称}｜{群名} {人数} 人' });
        const napcatCalls = [];
        const client = async (method, params) => {
            napcatCalls.push(method);
            if (method === 'get_group_info') return { group_name: '玄剑公会主群', member_count: 321 };
            if (method === 'get_group_member_info') return { card: '新人甲', nickname: '新人甲' };
            return {};
        };
        const msg = await welcome.buildWelcomeMessageForJoin({ groupId: GROUP_ID, userId: '22334455', client });
        check(
            '迎新 入群：渲染 @新人 + 昵称/群名/人数',
            !!msg && msg.mentioned === true && msg.text.includes('@22334455') && msg.text.includes('新人甲')
            && msg.text.includes('玄剑公会主群') && msg.text.includes('321 人'),
            (msg?.text || '').replace(/\n/g, ' '),
        );
        check('迎新 入群：消息段为 at + text', !!msg && msg.segments.some((s) => s.type === 'at') && msg.segments.some((s) => s.type === 'text'));
        check('迎新 入群：会取群信息与新人昵称', napcatCalls.includes('get_group_info') && napcatCalls.includes('get_group_member_info'), napcatCalls.join(','));

        // NapCat 挂了：降级为空变量，不抛异常
        const flaky = async () => { throw new Error('napcat down'); };
        const degraded = await welcome.buildWelcomeMessageForJoin({ groupId: GROUP_ID, userId: '22334455', client: flaky });
        check('迎新 入群：NapCat 故障时降级（不抛异常）', !!degraded && degraded.text.includes('欢迎'), (degraded?.text || '').replace(/\n/g, ' '));

        await run(welcomeEntry, { text: '开关 off' });
        const offMsg = await welcome.buildWelcomeMessageForJoin({ groupId: GROUP_ID, userId: '22334455', client });
        check('迎新 入群：本群关闭时不发消息', offMsg === null);
        await run(welcomeEntry, { text: '重置' });
    }

    // 用法 / 未知子指令 / 私聊
    {
        const usage = await run(welcomeEntry, { text: '' });
        check(
            '迎新 无参数给完整用法',
            ['#迎新 查看', '#迎新 设置', '#迎新 开关', '#迎新 测试', '#迎新 重置'].every((s) => usage.text.includes(s)),
            usage.text.replace(/\s+/g, ' ').slice(0, 50),
        );
        const unknown = await run(welcomeEntry, { text: '乱写' });
        check('迎新 未知子指令给用法而不是当文案存下', /未知的迎新子指令/.test(unknown.text) && unknown.sent.length === 0);
        const priv = await run(welcomeEntry, { text: '查看', groupId: '' });
        check('迎新 私聊时提示「按群保存」', /按群保存/.test(priv.text), priv.text.slice(0, 30));
    }

    // 存储损坏容错（写坏 JSON 后仍能读默认值、指令不崩）
    {
        const saved = fs.existsSync(WELCOME_FILE) ? fs.readFileSync(WELCOME_FILE, 'utf8') : null;
        fs.writeFileSync(WELCOME_FILE, '{ 这不是合法 JSON', 'utf8');
        const cfg = welcome.getWelcomeConfig(GROUP_ID);
        check('迎新 存储损坏时容错（回默认值、不抛异常）', cfg.enabled === true && cfg.mention === true && cfg.text === undefined);
        const r = await run(welcomeEntry, { text: '查看' });
        check('迎新 存储损坏时指令仍可用', /状态：已开启/.test(r.text));
        if (saved !== null) fs.writeFileSync(WELCOME_FILE, saved, 'utf8');
        else if (fs.existsSync(WELCOME_FILE)) fs.unlinkSync(WELCOME_FILE);
    }
}

/* ==================== 清理本地状态 ==================== */

if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
if (fs.existsSync(HELP_CACHE_FILE)) fs.unlinkSync(HELP_CACHE_FILE);
fs.rmSync(HELP_IMAGE_DIR, { recursive: true, force: true });
if (activityBackup !== null) fs.writeFileSync(ACTIVITY_FILE, activityBackup, 'utf8');
if (fs.existsSync(ACTIVITY_BACKUP)) fs.unlinkSync(ACTIVITY_BACKUP);
if (welcomeBackup !== null) fs.writeFileSync(WELCOME_FILE, welcomeBackup, 'utf8');
else if (fs.existsSync(WELCOME_FILE)) fs.unlinkSync(WELCOME_FILE);
if (fs.existsSync(WELCOME_BACKUP)) fs.unlinkSync(WELCOME_BACKUP);
console.log('\n（已清理干跑产生的 data/pay-broadcast.json、data/help-card.json、data/help-cards/、data/welcome.json 与临时备份）');

console.log(`\n=== 结果：通过 ${pass} / 失败 ${fail} ===\n`);
process.exit(fail ? 1 : 0);
