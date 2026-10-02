# TradeMind

> AI Trading Journal & Analytics Platform — 智能交易日志、交易分析、策略分析与 AI Trading Coach。
> 非交易所、非 Broker、不托管资产。参考 UltraTrader 公开产品结构，不复制其品牌/源码/视觉资产。

🌐 **在线预览与功能展示**：https://yabin01.github.io/TradeMind/

📦 **下载 Windows 便携版**（免安装 Node 与数据库）：[Releases](https://github.com/yabin01/TradeMind/releases/latest)

📄 **许可证**：[MIT](LICENSE) —— 可自由使用、修改、分发、商用

💙 **捐赠支持**：https://yabin01.github.io/TradeMind/donate.html

🤝 **交易所邀请链接**（通过链接注册费率不变）：https://yabin01.github.io/TradeMind/invite.html
📱 **安卓端（独立仓库）**：[trademind-mobile](https://github.com/yabin01/trademind-mobile) —— 同款离线优先交易日志，可装到手机，无需 Google Play

## 技术栈

- **Monorepo**：pnpm workspaces + Turborepo
- **API**：NestJS（`apps/api`，端口 4000）
- **Web**：Next.js 14 + Tailwind + TanStack Query + Zustand + Recharts + TradingView Lightweight Charts（`apps/web`，端口 3000，默认 Dark Mode）
- **数据库**：PostgreSQL 16（TimescaleDB 镜像）+ Drizzle ORM
- **队列**：Redis 7 + BullMQ（`workers/*`）
- **核心包**：`packages/trading-core`（领域模型/CSV 归一化/去重）、`packages/analytics`（纯函数分析引擎，已通过 45 项自测）、`packages/database`（Schema/Seed）

## 快速开始

```bash
# 0) 前置：Node 20+，pnpm（corepack enable），Docker
cd trademind
pnpm install

# 1) 启动 PostgreSQL + Redis
docker compose -f docker/docker-compose.yml up -d

# 2) 建表 + 种子数据（300 笔合成交易，120 天，含可检测的行为模式）
pnpm db:push
pnpm db:seed

# 3) 启动 API 与 Web（两个终端）
pnpm dev:api     # http://localhost:4000/api
pnpm dev:web     # http://localhost:3000
```

打开 http://localhost:3000 即可看到 Dashboard。

## 分析引擎公式（packages/analytics，纯函数，全量单测）

```
Gross Profit = Σ grossPnl > 0
Gross Loss   = Σ |grossPnl < 0|
Net PNL      = Gross Profit − Gross Loss − Fees − Funding (= Σ netPnl)
Win Rate     = Winning / Total Closed（按 netPnl 判定）
Profit Factor= Gross Profit / Gross Loss（GL=0 → ∞；无交易 → 0）
EV           = WinRate × AvgWin − LossRate × AvgLoss（净期望）
R:R          = |TP − Entry| × Qty / |Entry − SL| × Qty
Equity_t     = StartingBalance + Σ netPnl（按 closeTime 排序）
MaxDD / HWM / CurrentDD / DD Duration / Recovery Time 详见 drawdown.ts
```

运行自测：`pnpm --filter @trademind/analytics build && pnpm --filter @trademind/analytics test`

## API 一览（prefix: /api）

- `GET /dashboard?filter=` — KPI + Equity + Daily + 全维度聚合（一站式）
- `GET /trades` · `GET /trades/:id` · `POST /trades/import`（CSV）· `POST /trades`（手动）· `DELETE /trades/:id`
- `GET /trades/:id/candles?bar=` — 持仓期间 K 线（开仓/平仓点标注，用于单笔复盘）
- `GET /analytics` · `GET /analytics/time?kind=hour|dayOfWeek|session|duration` · `GET /analytics/symbol` · `GET /analytics/strategy`
- `GET /calendar` · `GET /strategies` · `GET /taxonomy`
- `GET /connections` · `POST /connections` · `POST /connections/:id/sync` · `DELETE /connections/:id`
- `POST /ai/daily-review | strategy-review | pattern-analysis | risk-analysis | trade-review`

鉴权（Phase 1 简化）：请求头 `x-workspace-id`，默认 demo 工作区 `22222222-2222-2222-2222-222222222222`。

## CSV 导入格式

表头大小写不敏感、支持中英文同义词，例：

```
symbol,side,positionSide,entryPrice,exitPrice,quantity,leverage,openTime,closeTime,fees,funding,stopLoss,takeProfit,strategy,tags,notes
BTCUSDT,BUY,NET,60000,61000,0.1,5,2026-09-01 08:00,2026-09-01 10:00,4.8,0.3,59400,62000,Breakout,Breakout|NewYork,突破回踩入场
```

去重：`externalTradeId`（存在即全局唯一）；无 ID 时按 `(exchange, accountId, openTime, closeTime, symbol, side)` 应用层去重。

## 项目结构

```
apps/web            Next.js 前端
apps/api            NestJS API
packages/trading-core   领域模型 · CSV 归一化 · 去重
packages/analytics      分析引擎（纯函数）
packages/database       Drizzle Schema · Seed
workers/*           BullMQ workers（sync / analytics / ai）
docker/             PG(TimescaleDB) + Redis compose
```

## 路线图

- ✅ Phase 1（当前）：数据模型 → 分析引擎 → Dashboard → CSV 导入
- ✅ 单笔复盘图：交易详情页的持仓期间 K 线（Lightweight Charts，开仓/平仓点标注 + 成交量 + 周期切换）
- 🔜 Phase 2：Binance/Bybit/OKX/Hyperliquid 连接器、实时同步、JWT 鉴权
- 🔜 Phase 3：LLM AI Coach（规则引擎已预置事实层与 Citation 结构）
- 🔜 Phase 4：Trade Replay（逐笔回放；单笔 K 线视图已随 Phase 1 一并落地）
- 🔜 Phase 5：ChanLun Analytics（schema 已预留 `chanlun` 字段）

## 许可证

[MIT](LICENSE) © 2026 yabin01

可以自由地使用、复制、修改、合并、发布、分发、再授权与销售，唯一的要求是：在你分发本软件（或其重要部分）时，保留版权声明与这份许可声明。软件按「现状」提供，不含任何形式的担保。

任何人都可以用它做任何事，包括商业用途 —— 包括把它打包成付费产品。这正是选择 MIT 而不是 copyleft 协议的原因。

## 免责声明

TradeMind 是一款个人交易记录与统计分析工具，**不是交易所、不是经纪商、不提供投资建议，也不托管任何资产**。
它只读取你主动配置的历史成交数据用于分析，没有任何下单或转账功能。
所有分析结论均基于你自己的历史数据，不构成任何投资或交易建议。交易有风险，决策请自行判断。
