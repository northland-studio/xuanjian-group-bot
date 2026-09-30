# 玄剑公会 QQ 群机器人 (xuanjian-group-bot)

基于 **NapCatQQ + node-napcat-ts** 的玄剑公会 QQ 群机器人，用于打通官网能力与 QQ 群。

- 协议端：NapCatQQ（OneBot 正向 WebSocket）
- 对接 SDK：`node-napcat-ts`（TypeScript）
- 官网联动：通过官网 HTTP 接口（`X-Bot-Token` 鉴权）读取档案 / 排行 / 处分 / 任务等
- 运行环境：Node.js ≥ 20 + PM2 / systemd

## 功能列表

### 公开查询
| 指令 | 说明 |
| --- | --- |
| `#帮助` / `#help` | 查看指令总览**图片**（官网渲染，失败自动回退文字列表）；`#help 刷新` 或 `#指令图` 强制重新生成 |
| `#档案 <ID/昵称>` | 查询成员档案（贡献点 / 代系 / 处分） |
| `#处分 <ID/昵称>` | 查询处分记录 |
| `#贡献排行` | 贡献点排行榜 Top10 |
| `#签到排行` | 签到排行榜 Top10 |
| `#在线` | 官网在线玩家 |
| `#日报` / `#决策` | 拉取官网最新日报 / 决策 |
| `#活跃` / `#昨日活跃` | 今日 / 昨日群发言活跃排行 |

### 账号绑定
| 指令 | 说明 |
| --- | --- |
| `#绑定 <用户名>` | 群内发起绑定，生成一次性码，官网「账户设置 → 群机器人绑定」确认 |
| `#查自己` | 按已绑定 QQ 查询自己的档案 |

### 群管理（仅管理员）
| 指令 | 说明 |
| --- | --- |
| `#禁言 @QQ 分钟` | 禁言成员 |
| `#解禁 @QQ` | 解除禁言 |
| `#踢人 @QQ` | 移出成员 |
| `#名片 @QQ 新名片` | 设置成员名片 |
| `#迎新 查看` / `#欢迎查看` | 查看本群迎新词开关与文案 |
| `#迎新 设置 <文本>` / `#设置迎新 <文本>` | 保存本群迎新词（≤500 字，支持 `{换行}`） |
| `#迎新 开关 on\|off` / `#迎新开关 on\|off` | 开启 / 关闭入群欢迎 |
| `#迎新 @ on\|off` | 迎新词里的 `{at}` 是否变成真实 @ 新人 |
| `#迎新 测试 [文本]` | 按当前配置在群里发一条测试（标明「测试」，不 @ 真人） |
| `#迎新 重置` | 清空本群自定义迎新词，回到默认文案 |

迎新词模板变量：`{at}` `{昵称}` `{群名}` `{人数}` `{时间}` `{换行}`；按群保存，新人入群（`notice.group_increase`）时自动发送。

### 核销 / 任务（私聊敏感操作）
| 指令 | 说明 |
| --- | --- |
| `核销 <码>` | 管理员私聊验证核销码 |
| `核销确认 <码>` | 管理员私聊确认核销 |
| `任务码 <任务ID> <验证码>` | 接取者私聊提交玩家任务完成验证码 |

### 娱乐
| 指令 | 说明 |
| --- | --- |
| `#运势` | 今日运势 |
| `#抽签` | 抽个签 |
| `#掷骰 [面数]` | 掷骰子（默认 6 面） |

## 目录结构

```
src/
├── index.ts              # 入口：连接 NapCat、事件分发（含入群迎新）
├── config.ts             # 配置读取（.env）
├── core/
│   └── command.ts        # 指令注册 / 解析
├── handlers/
│   └── commands.ts       # 指令实现
└── services/
    ├── officialApi.ts    # 官网 HTTP 客户端
    ├── helpCard.ts       # 指令帮助图（分组 + 缓存 + 刷新）
    ├── welcome.ts        # 迎新词（每群配置 + 模板变量）
    ├── activity.ts       # 群活跃统计（本地 JSON）
    └── store.ts          # 本地 JSON 持久化
data/                     # 运行时数据（本地 JSON，自动创建）
├── activity.json         # 群活跃统计
├── pay-broadcast.json    # 播报游标
├── help-card.json        # 帮助图缓存（url/hash/有效期）
└── welcome.json          # 每群迎新词配置
```

## 环境变量（.env）

| 变量 | 说明 |
| --- | --- |
| `NAPCAT_BASE_URL` | NapCat 正向 WS 地址（如 `ws://127.0.0.1:3001`） |
| `NAPCAT_HOST` / `NAPCAT_PORT` | 备选连接方式 |
| `NAPCAT_TOKEN` | NapCat WS 鉴权 token |
| `ALLOWED_GROUPS` | 允许的 QQ 群号（逗号分隔） |
| `ADMIN_QQ` | 管理员 QQ 号（逗号分隔，拥有禁言/核销等权限） |
| `OFFICIAL_API_BASE` | 官网 API 地址 |
| `OFFICIAL_BOT_TOKEN` | 官网为机器人分配的 token（`X-Bot-Token`） |

## 部署

1. 安装依赖：`npm install`
2. 配置 `.env`（参考 `.env.example`）
3. 构建：`npm run build`
4. 启动：`npm start`（或 `pm2 start ecosystem.config.cjs`）

NapCat 需先部署并登录机器人 QQ，配置正向 WebSocket（默认端口 3001）。

## License

[MIT](./LICENSE)
