import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * TradeMind 数据库 Schema（PostgreSQL 16 + TimescaleDB 可选）。
 * 隔离：所有业务表带 workspace_id，API 层强制过滤，杜绝跨用户泄漏。
 * 金额统一 doublePrecision（MVP 足够；后续可迁 numeric(20,8)）。
 */

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const portfolios = pgTable('portfolios', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(),
  type: text('type').notNull().default('CRYPTO'), // CRYPTO | FOREX | STOCKS | TEST
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Broker 连接（CSV / 交易所 API），同步状态机：Connected→Syncing→Success|Failed|Expired */
export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  exchange: text('exchange').notNull(), // Exchange 枚举字符串
  name: text('name').notNull(),
  status: text('status').notNull().default('CONNECTED'),
  credentials: jsonb('credentials'), // 加密存储（Phase 2），CSV 连接为空
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  // 自动同步：开启后调度器按间隔增量拉取，新成交自动进日志
  autoSync: boolean('auto_sync').notNull().default(false),
  syncIntervalMin: integer('sync_interval_min').notNull().default(15),
  lastError: text('last_error'),
  /** 最近一次权限探测结果：{ readOnly, read, trade, withdraw, checkedAt } */
  permissions: jsonb('permissions'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});


export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    portfolioId: uuid('portfolio_id').references(() => portfolios.id),
    connectionId: uuid('connection_id').references(() => connections.id),
    name: text('name').notNull(),
    exchange: text('exchange').notNull(),
    type: text('type').notNull().default('PERPETUAL'), // SPOT|MARGIN|PERPETUAL|FUTURES
    currency: text('currency').notNull().default('USDT'),
    startingBalance: doublePrecision('starting_balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ workspaceIdx: index('accounts_workspace_idx').on(t.workspaceId) }),
);

export const strategies = pgTable(
  'strategies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsNameUq: uniqueIndex('strategies_ws_name_uq').on(t.workspaceId, t.name) }),
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ wsNameUq: uniqueIndex('tags_ws_name_uq').on(t.workspaceId, t.name) }),
);

export const mistakes = pgTable(
  'mistakes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
  },
  (t) => ({ wsNameUq: uniqueIndex('mistakes_ws_name_uq').on(t.workspaceId, t.name) }),
);

export const trades = pgTable(
  'trades',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(), // BUY | SELL
    positionSide: text('position_side').notNull(), // LONG | SHORT | NET

    entryPrice: doublePrecision('entry_price').notNull(),
    exitPrice: doublePrecision('exit_price'),
    quantity: doublePrecision('quantity').notNull(),
    leverage: integer('leverage').notNull().default(1),
    stopLoss: doublePrecision('stop_loss'),
    takeProfit: doublePrecision('take_profit'),

    openTime: timestamp('open_time', { withTimezone: true }).notNull(),
    closeTime: timestamp('close_time', { withTimezone: true }),

    grossPnl: doublePrecision('gross_pnl').notNull().default(0),
    fees: doublePrecision('fees').notNull().default(0),
    funding: doublePrecision('funding').notNull().default(0),
    netPnl: doublePrecision('net_pnl').notNull().default(0),

    risk: doublePrecision('risk'),
    reward: doublePrecision('reward'),
    rr: doublePrecision('rr'),

    strategyId: uuid('strategy_id').references(() => strategies.id),
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`), // tag id 数组（读路径冗余）
    /** 入场理由标签（名称数组，对齐 TMM Entry Reasons） */
    entryTags: jsonb('entry_tags').notNull().default(sql`'[]'::jsonb`),
    /** 出场理由标签 */
    exitTags: jsonb('exit_tags').notNull().default(sql`'[]'::jsonb`),
    /** 归档：true 时移出全部统计（Archive 语义），可恢复 */
    archived: boolean('archived').notNull().default(false),
    mistakes: jsonb('mistakes').notNull().default(sql`'[]'::jsonb`),
    confidence: integer('confidence'),
    marketCondition: text('market_condition'),
    notes: text('notes'),
    screenshots: jsonb('screenshots').notNull().default(sql`'[]'::jsonb`),

    externalTradeId: text('external_trade_id'),
    chanlun: jsonb('chanlun'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    wsIdx: index('trades_ws_idx').on(t.workspaceId),
    accountCloseIdx: index('trades_account_close_idx').on(t.accountId, t.closeTime),
    // 去重优先级 1：externalTradeId 存在时全库唯一
    externalUq: uniqueIndex('trades_external_uq')
      .on(t.exchange, t.accountId, t.externalTradeId)
      .where(sql`external_trade_id is not null`),
  }),
);

/** 交易规则：用于自动标记违规（风险与纪律约束） */
export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    // MAX_LOSS_PER_TRADE | MAX_DAILY_LOSS | REVENGE_AFTER_LOSS | MAX_LEVERAGE
    // SESSION_BLACKLIST | MAX_HOLDING_MINUTES | MIN_RR
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** 阈值/参数：{ value: number } 或 { hours: number[] } 或 { count: number, withinMinutes: number } */
    params: jsonb('params').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsIdx: index('rules_ws_idx').on(t.workspaceId) }),
);

/** 违规记录：规则评估后写入，tradeId+ruleId 唯一，避免重复标记 */
export const tradeViolations = pgTable(
  'trade_violations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => trades.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('trade_violations_trade_rule_uq').on(t.tradeId, t.ruleId),
    wsIdx: index('trade_violations_ws_idx').on(t.workspaceId),
  }),
);

export const tradeTags = pgTable(
  'trade_tags',
  {
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => trades.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tradeId, t.tagId] }) }),
);

export const tradeMistakes = pgTable(
  'trade_mistakes',
  {
    tradeId: uuid('trade_id')
      .notNull()
      .references(() => trades.id, { onDelete: 'cascade' }),
    mistakeId: uuid('mistake_id')
      .notNull()
      .references(() => mistakes.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tradeId, t.mistakeId] }) }),
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    tradeId: uuid('trade_id').references(() => trades.id),
    exchange: text('exchange').notNull(),
    symbol: text('symbol').notNull(),
    side: text('side').notNull(),
    type: text('type').notNull(), // MARKET|LIMIT|STOP|STOP_MARKET|TAKE_PROFIT|REDUCE_ONLY|POST_ONLY
    price: doublePrecision('price'),
    quantity: doublePrecision('quantity').notNull(),
    status: text('status').notNull(),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
  },
  (t) => ({ accountIdx: index('orders_account_idx').on(t.accountId) }),
);

export const executions = pgTable('executions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),
  price: doublePrecision('price').notNull(),
  quantity: doublePrecision('quantity').notNull(),
  fee: doublePrecision('fee').notNull().default(0),
  timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
});

export const positions = pgTable('positions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  accountId: uuid('account_id')
    .notNull()
    .references(() => accounts.id),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),
  type: text('type').notNull().default('PERPETUAL'),
  entry: doublePrecision('entry').notNull(),
  size: doublePrecision('size').notNull(),
  leverage: integer('leverage').notNull().default(1),
  margin: doublePrecision('margin').notNull().default(0),
  liquidationPrice: doublePrecision('liquidation_price'),
  unrealizedPnl: doublePrecision('unrealized_pnl').notNull().default(0),
  realizedPnl: doublePrecision('realized_pnl').notNull().default(0),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export const tradeNotes = pgTable('trade_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeId: uuid('trade_id')
    .notNull()
    .references(() => trades.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tradeImages = pgTable('trade_images', {
  id: uuid('id').primaryKey().defaultRandom(),
  tradeId: uuid('trade_id')
    .notNull()
    .references(() => trades.id, { onDelete: 'cascade' }),
  storageKey: text('storage_key').notNull(), // Object Storage key
  caption: text('caption'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 指标物化（TimescaleDB hypertable 候选） */
export const dailyMetrics = pgTable(
  'daily_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    day: date('day').notNull(),
    trades: integer('trades').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    pnl: doublePrecision('pnl').notNull().default(0),
    fees: doublePrecision('fees').notNull().default(0),
    winRate: doublePrecision('win_rate').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ accountDayUq: uniqueIndex('daily_metrics_account_day_uq').on(t.accountId, t.day) }),
);

export const hourlyMetrics = pgTable(
  'hourly_metrics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
    trades: integer('trades').notNull().default(0),
    wins: integer('wins').notNull().default(0),
    pnl: doublePrecision('pnl').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountHourUq: uniqueIndex('hourly_metrics_account_hour_uq').on(t.accountId, t.hourBucket),
  }),
);

export const aiInsights = pgTable('ai_insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  type: text('type').notNull(), // DAILY_REVIEW | STRATEGY_REVIEW | PATTERN | RISK
  title: text('title').notNull(),
  content: jsonb('content').notNull(), // 结构化结论
  tradeRefs: jsonb('trade_refs').notNull().default(sql`'[]'::jsonb`), // 引用的 trade id，UI 可 View Trades
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const aiReports = pgTable('ai_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  type: text('type').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  content: jsonb('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const sessionDefs = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull(),
  name: text('name').notNull(), // ASIA | LONDON | NEW_YORK
  startMinute: integer('start_minute').notNull(),
  endMinute: integer('end_minute').notNull(),
  tzOffsetMinutes: integer('tz_offset_minutes').notNull().default(0),
});

/** Diary 复盘笔记：月 / 周 / 日三级，periodKey = 2026-09 | 2026-09-22（周一起始日）| 2026-09-26 */
export const diaryNotes = pgTable(
  'diary_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    scope: text('scope').notNull(), // MONTH | WEEK | DAY
    periodKey: text('period_key').notNull(),
    /** 1-5 星自评（TMM：rate your trading） */
    rating: integer('rating'),
    content: text('content'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('diary_notes_scope_period_uq').on(t.workspaceId, t.scope, t.periodKey),
  }),
);

/** AI 教练对话会话（多轮持久化，替代一次性分析卡片） */
export const coachSessions = pgTable(
  'coach_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    title: text('title').notNull().default('新对话'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsIdx: index('coach_sessions_ws_idx').on(t.workspaceId) }),
);

/**
 * AI 教练消息。
 * role: user | assistant
 * meta: { facts, tradeRefs, followUps, chart, memory } —— 事实层与引导项随消息持久化
 */
export const coachMessages = pgTable(
  'coach_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => coachSessions.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: text('content').notNull(),
    intent: text('intent'),
    meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessIdx: index('coach_messages_session_idx').on(t.sessionId),
    wsIdx: index('coach_messages_ws_idx').on(t.workspaceId),
  }),
);

/**
 * AI 教练记忆/承诺（问责机制）。
 * kind: GOAL（目标）| RULE（自定铁律）| NOTE（长期备注）
 * metric+threshold：可量化校验项（maxDailyLoss / maxLeverage / maxTradesPerDay），
 * 教练每次回答前会拿真实数据对账，做到「记住了还要盯住」。
 */
export const coachMemory = pgTable(
  'coach_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    metric: text('metric'),
    threshold: doublePrecision('threshold'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsIdx: index('coach_memory_ws_idx').on(t.workspaceId) }),
);

/** 筛选模板：保存的 FilterSet，favorite 的自动应用 */
export const filterPresets = pgTable(
  'filter_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    filter: jsonb('filter').notNull().default(sql`'{}'::jsonb`),
    favorite: boolean('favorite').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ wsIdx: index('filter_presets_ws_idx').on(t.workspaceId) }),
);

/**
 * 持仓标注：给「当前未平仓仓位」补入场理由 / 标签 / 备注。
 * 持仓本身是实时从交易所拉取的（不落库），这里只持久化用户标注，
 * 键 = workspaceId + accountId + symbol + positionSide（NET 模式下 positionSide='NET'）。
 */
export const positionNotes = pgTable(
  'position_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    accountId: uuid('account_id').notNull(),
    symbol: text('symbol').notNull(),
    positionSide: text('position_side').notNull(),
    /** 入场理由标签（名称数组，与 trades.entryTags 同口径） */
    entryTags: jsonb('entry_tags').notNull().default(sql`'[]'::jsonb`),
    /** 通用标签（名称数组） */
    tags: jsonb('tags').notNull().default(sql`'[]'::jsonb`),
    notes: text('notes'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uq: uniqueIndex('position_notes_key_uq').on(t.workspaceId, t.accountId, t.symbol, t.positionSide),
    wsIdx: index('position_notes_ws_idx').on(t.workspaceId),
  }),
);
