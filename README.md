# TradeMind

> AI Trading Journal & Analytics Platform — 智能交易日志、交易分析、策略分析与 AI Trading Coach。
> 非交易所、非 Broker、不托管资产。参考 UltraTrader 公开产品结构，不复制其品牌/源码/视觉资产。

## 技术栈

- **Monorepo**：pnpm workspaces + Turborepo
- **API**：NestJS（`apps/api`，端口 4000）
- **Web**：Next.js 14 + Tailwind + TanStack Query + Zustand + Recharts（`apps/web`，端口 3000，默认 Dark Mode）
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
- 🔜 Phase 2：Binance/Bybit/OKX/Hyperliquid 连接器、实时同步、JWT 鉴权
- 🔜 Phase 3：LLM AI Coach（规则引擎已预置事实层与 Citation 结构）
- 🔜 Phase 4：Trade Replay（Lightweight Charts）
- 🔜 Phase 5：ChanLun Analytics（schema 已预留 `chanlun` 字段）
