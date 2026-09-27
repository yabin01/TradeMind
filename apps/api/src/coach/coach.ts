import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { UnifiedTrade } from '@trademind/trading-core';
import {
  aggregateByMistake,
  aggregateBySymbol,
  aggregateByTag,
  aggregateByTime,
  buildImprovementPlan,
  closed,
  computeCoreMetrics,
  detectRevengeTrades,
  getSession,
} from '@trademind/analytics';
import {
  coachMemory as coachMemoryTable,
  coachMessages as coachMessagesTable,
  coachSessions as coachSessionsTable,
  rules as rulesTable,
  tradeViolations as tradeViolationsTable,
} from '@trademind/database';
import { createTradeRepo } from '../common/trades-repo';
import { workspaceOf } from '../common/workspace';

/* ------------------------------------------------------------------ 类型 */

export interface CoachFact {
  label: string;
  value: string;
}

export interface CoachChart {
  type: 'bars';
  title: string;
  unit: string;
  data: { label: string; value: number }[];
}

export interface CoachMeta {
  facts: CoachFact[];
  tradeRefs: string[];
  followUps: string[];
  chart: CoachChart | null;
}

export interface CoachMessageDto {
  id: string;
  role: string;
  content: string;
  intent: string | null;
  meta: CoachMeta;
  createdAt: string;
}

export interface CoachSessionDto {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface MemoryDto {
  id: string;
  kind: string;
  content: string;
  metric: string | null;
  threshold: number | null;
  active: boolean;
  createdAt: string;
  /** 对账结果（可量化项才有） */
  status: 'ok' | 'breached' | 'unknown' | null;
  statusText: string | null;
}

interface Answer {
  content: string;
  facts: CoachFact[];
  tradeRefs: string[];
  followUps: string[];
  chart: CoachChart | null;
}

interface RangeResult {
  trades: UnifiedTrade[];
  label: string;
}

/* ------------------------------------------------------------- 格式化帮助 */

const num = (v: number, d = 2): string => v.toFixed(d);
const money = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const pctFmt = (v: number): string => `${(v * 100).toFixed(1)}%`;
const pfFmt = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '∞');
const DAY = 86_400_000;

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** DimensionStats 不带 id 列表，按分组 key 反查真实交易 id（上限 20 条，保证可回溯） */
function refsFor(trades: UnifiedTrade[], match: (t: UnifiedTrade) => boolean): string[] {
  return trades.filter(match).slice(0, 20).map((t) => t.id);
}

/* ------------------------------------------------------------ 教练服务体 */

/**
 * AI 教练（对话式）。
 * 设计原则与全局一致：**结论必须来自数据库聚合，绝不虚构**。
 * Phase 1 用规则 + 意图路由作答；每条答复带 facts / tradeRefs / followUps，
 * 可逐项点开回溯原始交易。Phase 3 可把同一答案换成 LLM 生成，facts 留作事实层。
 */
export class CoachService {
  private repo = createTradeRepo();

  /* ------------------------------------------------------------ 会话 CRUD */

  async listSessions(workspaceId: string): Promise<CoachSessionDto[]> {
    const db = this.repo.db;
    const sessions = await db
      .select()
      .from(coachSessionsTable)
      .where(eq(coachSessionsTable.workspaceId, workspaceId))
      .orderBy(desc(coachSessionsTable.updatedAt));

    const counts = await db
      .select({
        sessionId: coachMessagesTable.sessionId,
        cnt: sql<number>`count(*)::int`,
      })
      .from(coachMessagesTable)
      .where(eq(coachMessagesTable.workspaceId, workspaceId))
      .groupBy(coachMessagesTable.sessionId);
    const map = new Map(counts.map((c) => [c.sessionId, Number(c.cnt)]));

    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      messageCount: map.get(s.id) ?? 0,
    }));
  }

  async createSession(workspaceId: string, title?: string): Promise<CoachSessionDto> {
    const [row] = await this.repo.db
      .insert(coachSessionsTable)
      .values({ workspaceId, title: title ?? '新对话' })
      .returning();
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messageCount: 0,
    };
  }

  async getSession(workspaceId: string, sessionId: string): Promise<{
    session: CoachSessionDto;
    messages: CoachMessageDto[];
  }> {
    const db = this.repo.db;
    const [row] = await db
      .select()
      .from(coachSessionsTable)
      .where(and(eq(coachSessionsTable.id, sessionId), eq(coachSessionsTable.workspaceId, workspaceId)));
    if (!row) throw new Error('会话不存在');

    const msgs = await db
      .select()
      .from(coachMessagesTable)
      .where(and(eq(coachMessagesTable.sessionId, sessionId), eq(coachMessagesTable.workspaceId, workspaceId)))
      .orderBy(coachMessagesTable.createdAt);

    return {
      session: {
        id: row.id,
        title: row.title,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        messageCount: msgs.length,
      },
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        intent: m.intent,
        meta: this.metaOf(m.meta),
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  async renameSession(workspaceId: string, sessionId: string, title: string): Promise<CoachSessionDto> {
    const [row] = await this.repo.db
      .update(coachSessionsTable)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(coachSessionsTable.id, sessionId), eq(coachSessionsTable.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new Error('会话不存在');
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messageCount: 0,
    };
  }

  async deleteSession(workspaceId: string, sessionId: string): Promise<{ deleted: boolean }> {
    const rows = await this.repo.db
      .delete(coachSessionsTable)
      .where(and(eq(coachSessionsTable.id, sessionId), eq(coachSessionsTable.workspaceId, workspaceId)))
      .returning();
    return { deleted: rows.length > 0 };
  }

  /* ------------------------------------------------------------ 记忆/问责 */

  async listMemory(workspaceId: string): Promise<MemoryDto[]> {
    const rows = await this.repo.db
      .select()
      .from(coachMemoryTable)
      .where(and(eq(coachMemoryTable.workspaceId, workspaceId), eq(coachMemoryTable.active, true)))
      .orderBy(desc(coachMemoryTable.createdAt));

    const all = await this.repo.loadTrades(workspaceId);
    const checked = await Promise.all(rows.map((r) => this.withStatus(r, all)));
    return checked;
  }

  async addMemory(workspaceId: string, kind: string, content: string): Promise<MemoryDto> {
    const parsed = this.parseCommitment(content);
    const [row] = await this.repo.db
      .insert(coachMemoryTable)
      .values({
        workspaceId,
        kind: kind || (parsed.metric ? 'GOAL' : 'NOTE'),
        content,
        metric: parsed.metric,
        threshold: parsed.threshold,
      })
      .returning();
    const all = await this.repo.loadTrades(workspaceId);
    const dto = await this.withStatus(row, all);

    return dto;
  }

  async deleteMemory(workspaceId: string, id: string): Promise<{ deleted: boolean }> {
    const rows = await this.repo.db
      .update(coachMemoryTable)
      .set({ active: false })
      .where(and(eq(coachMemoryTable.id, id), eq(coachMemoryTable.workspaceId, workspaceId)))
      .returning();
    return { deleted: rows.length > 0 };
  }

  /** 承诺描述 → 可量化校验项。例：「每天最多亏 200」→ maxDailyLoss / 200 */
  private parseCommitment(text: string): { metric: string | null; threshold: number | null } {
    const nums = text.match(/\d+(\.\d+)?/g);
    const n = nums ? Number(nums[0]) : null;
    if (n === null) return { metric: null, threshold: null };
    if (/(亏|损|回撤|止损)/.test(text) && /(天|日)/.test(text)) return { metric: 'maxDailyLoss', threshold: n };
    if (/(亏|损|回撤)/.test(text) && /(笔|单|周|月)/.test(text)) return { metric: 'maxDailyLoss', threshold: n };
    if (/杠杆|倍数/.test(text)) return { metric: 'maxLeverage', threshold: n };
    if (/(笔|单).{0,4}(天|日)|每天.{0,4}(笔|单)|出手/.test(text)) return { metric: 'maxTradesPerDay', threshold: n };
    return { metric: null, threshold: null };
  }

  /** 拿真实数据给承诺对账 */
  private async withStatus(
    row: typeof coachMemoryTable.$inferSelect,
    trades: UnifiedTrade[],
  ): Promise<MemoryDto> {
    const base: MemoryDto = {
      id: row.id,
      kind: row.kind,
      content: row.content,
      metric: row.metric,
      threshold: row.threshold,
      active: row.active,
      createdAt: row.createdAt.toISOString(),
      status: null,
      statusText: null,
    };
    if (!row.metric || row.threshold === null) return base;

    const cs = closed(trades);
    if (cs.length === 0) return { ...base, status: 'unknown', statusText: '暂无已平仓交易可核对' };

    // 只看最近 30 天，避免用陈年旧账评判当下的自律
    const last = new Date(cs[cs.length - 1].closeTime as string).getTime();
    const recent = cs.filter((t) => last - new Date(t.closeTime as string).getTime() <= 30 * DAY);

    if (row.metric === 'maxLeverage') {
      const maxLev = Math.max(...recent.map((t) => t.leverage ?? 0));
      const over = maxLev > row.threshold;
      return {
        ...base,
        status: over ? 'breached' : 'ok',
        statusText: `近 30 天最大杠杆 ${num(maxLev, 0)}x（上限 ${num(row.threshold, 0)}x）`,
      };
    }

    if (row.metric === 'maxTradesPerDay') {
      const byDay = new Map<string, number>();
      for (const t of recent) {
        const d = (t.closeTime as string).slice(0, 10);
        byDay.set(d, (byDay.get(d) ?? 0) + 1);
      }
      const maxTrades = Math.max(...byDay.values());
      const over = maxTrades > row.threshold;
      return {
        ...base,
        status: over ? 'breached' : 'ok',
        statusText: `近 30 天单日最多 ${maxTrades} 笔（上限 ${num(row.threshold, 0)} 笔）`,
      };
    }

    // maxDailyLoss
    const byDayPnl = new Map<string, number>();
    for (const t of recent) {
      const d = (t.closeTime as string).slice(0, 10);
      byDayPnl.set(d, (byDayPnl.get(d) ?? 0) + t.netPnl);
    }
    const losses = [...byDayPnl.values()].filter((v) => v < 0);
    const worstDay = losses.length > 0 ? Math.min(...losses) : 0;
    const over = -worstDay > row.threshold;
    return {
      ...base,
      status: over ? 'breached' : 'ok',
      statusText: `近 30 天最大单日亏损 ${money(worstDay)}（上限 ${num(row.threshold, 0)}）`,
    };
  }

  /* ---------------------------------------------------------- 发消息主流程 */

  async sendMessage(workspaceId: string, sessionId: string, text: string): Promise<{
    user: CoachMessageDto;
    assistant: CoachMessageDto;
    autoTitle: string | null;
  }> {
    const db = this.repo.db;
    const trimmed = (text ?? '').trim();
    if (!trimmed) throw new Error('消息不能为空');

    const [session] = await db
      .select()
      .from(coachSessionsTable)
      .where(and(eq(coachSessionsTable.id, sessionId), eq(coachSessionsTable.workspaceId, workspaceId)));
    if (!session) throw new Error('会话不存在');

    const [userRow] = await db
      .insert(coachMessagesTable)
      .values({ workspaceId, sessionId, role: 'user', content: trimmed })
      .returning();

    const intent = this.detectIntent(trimmed);
    const answer = await this.answer(workspaceId, intent, trimmed);

    const [assistantRow] = await db
      .insert(coachMessagesTable)
      .values({
        workspaceId,
        sessionId,
        role: 'assistant',
        content: answer.content,
        intent,
        meta: {
          facts: answer.facts,
          tradeRefs: answer.tradeRefs,
          followUps: answer.followUps,
          chart: answer.chart,
        },
      })
      .returning();

    // 首条提问自动命名会话标题
    let autoTitle: string | null = null;
    if (session.title === '新对话') {
      autoTitle = trimmed.length > 22 ? `${trimmed.slice(0, 22)}…` : trimmed;
      await db.update(coachSessionsTable).set({ title: autoTitle, updatedAt: new Date() }).where(eq(coachSessionsTable.id, sessionId));
    } else {
      await db.update(coachSessionsTable).set({ updatedAt: new Date() }).where(eq(coachSessionsTable.id, sessionId));
    }

    return {
      user: {
        id: userRow.id,
        role: userRow.role,
        content: userRow.content,
        intent: null,
        meta: { facts: [], tradeRefs: [], followUps: [], chart: null },
        createdAt: userRow.createdAt.toISOString(),
      },
      assistant: {
        id: assistantRow.id,
        role: assistantRow.role,
        content: assistantRow.content,
        intent,
        meta: {
          facts: answer.facts,
          tradeRefs: answer.tradeRefs,
          followUps: answer.followUps,
          chart: answer.chart,
        },
        createdAt: assistantRow.createdAt.toISOString(),
      },
      autoTitle,
    };
  }

  /** 无会话的一次性提问（供其它页面嵌入调用） */
  async ask(workspaceId: string, text: string): Promise<{ intent: string; answer: Answer }> {
    const trimmed = (text ?? '').trim();
    const intent = this.detectIntent(trimmed);
    const answer = await this.answer(workspaceId, intent, trimmed);
    return { intent, answer };
  }

  /* ------------------------------------------------------------ 意图路由 */

  private detectIntent(q: string): string {
    const s = q.toLowerCase();
    if (/^(你好|您好|hi|hello|哈喽|早上好|晚上好|在吗)/.test(s)) return 'greeting';
    if (/(帮助|能做什么|怎么用|会做什么|help|功能)/.test(s)) return 'help';
    if (/(记住|帮我记|以后我|从今天起我|我的规矩是|我的目标是|我给自己定)/.test(s)) return 'remember';
    if (/(我(之前|以前)?(记过|定过|说过|写过)的|我(还)?定过什么|我的目标|我的规矩|我的承诺|哪些(承诺|目标|规矩))/i.test(s))
      return 'memory_list';

    if (/(违规|违反规则|触犯|破了哪条|规则的违反)/.test(s)) return 'violation';
    if (/(报复|上头|冲动|连着开|扳本|加仓扳)/.test(s)) return 'revenge';
    if (/(连败|连亏|连续亏损|连赢|连续盈利| streak)/.test(s)) return 'streak';
    if (/(出错|失误|犯错|什么错|mistake|错误)/.test(s)) return 'mistake';
    if (/(入场理由|进场理由|开仓理由|为什么进|entry\s*reason|入场表现)/.test(s)) return 'entry';
    if (/(出场理由|平仓理由|离场理由|为什么平|exit\s*reason)/.test(s)) return 'exit';
    if (/(品种|币种|标的|哪个币|symbol|哪个品种)/.test(s)) return 'symbol';
    if (/(几点|时段|小时|亚洲|亚盘|伦敦|纽约|美盘|欧盘|session)/.test(s)) return 'session';
    if (/(亏最多|最大亏损|最惨|worst|哪笔亏|亏得最多)/.test(s)) return 'worst';
    if (/(赚最多|最好交易|最大盈利|best|哪笔赚)/.test(s)) return 'best';
    if (/(胜率|成功概率|盈亏因子|profit\s*factor|期望|ev\b|最大回撤|盈亏比|邮差)/.test(s)) return 'metrics';
    if (/(改进|改什么|先改|计划|下一步|怎么提升|怎么改|如何改进|该怎么做|建议我|plan)/.test(s)) return 'plan';
    if (/(今天|今日|本周|这周|本月|这个月|最近|近几天|昨天)/.test(s)) return 'recent';
    if (/(概况|总体|总结一下|总结|复盘|怎么样|表现如何|总览|overview|看看我的交易)/.test(s)) return 'overview';
    return 'overview';
  }

  private async answer(workspaceId: string, intent: string, q: string): Promise<Answer> {
    const all = await this.repo.loadTrades(workspaceId);
    const range = this.sliceRange(q, all);
    const memories = await this.listMemory(workspaceId);

    switch (intent) {
      case 'greeting':
        return this.aGreeting(range, memories);
      case 'help':
        return this.aHelp();
      case 'remember':
        return this.aRemember(workspaceId, q);
      case 'memory_list':
        return this.aMemoryList(memories);
      case 'violation':
        return this.aViolation(workspaceId, range, all);
      case 'revenge':
        return this.aRevenge(range);
      case 'streak':
        return this.aStreak(range);
      case 'mistake':
        return this.aMistake(range);
      case 'entry':
        return this.aEntry(range);
      case 'exit':
        return this.aExit(range);
      case 'symbol':
        return this.aSymbol(range);
      case 'session':
        return this.aSession(range);
      case 'worst':
        return this.aWorst(range);
      case 'best':
        return this.aBest(range);
      case 'metrics':
        return this.aMetrics(range);
      case 'plan':
        return this.aPlan(range);
      case 'recent':
        return this.aRecent(range);
      default:
        return this.aOverview(range, memories);
    }
  }

  /* ------------------------------------------------------ 时间范围切片 */

  private sliceRange(q: string, trades: UnifiedTrade[]): RangeResult {
    const cs = closed(trades).sort((a, b) => String(a.closeTime).localeCompare(String(b.closeTime)));
    if (cs.length === 0) return { trades: [], label: '全部数据' };
    const lastMs = new Date(cs[cs.length - 1].closeTime as string).getTime();

    const m = q.match(/最近\s*(\d+)\s*(天|日)/);
    if (m) {
      const days = Number(m[1]);
      const from = lastMs - days * DAY;
      return {
        trades: cs.filter((t) => new Date(t.closeTime as string).getTime() >= from),
        label: `最近 ${days} 天`,
      };
    }
    const n = q.match(/最近\s*(\d+)\s*笔/);
    if (n) {
      const take = Number(n[1]);
      return { trades: cs.slice(-take), label: `最近 ${take} 笔` };
    }
    if (/(今天|今日|今天的表现)/.test(q)) {
      const d = isoDay(new Date(lastMs));
      return { trades: cs.filter((t) => (t.closeTime as string).slice(0, 10) === d), label: `今天（${d}）` };
    }
    if (/(昨天)/.test(q)) {
      const d = isoDay(new Date(lastMs - DAY));
      return { trades: cs.filter((t) => (t.closeTime as string).slice(0, 10) === d), label: `昨天（${d}）` };
    }
    if (/(本周|这周)/.test(q)) {
      const from = lastMs - 7 * DAY;
      return { trades: cs.filter((t) => new Date(t.closeTime as string).getTime() >= from), label: '本周（近 7 天）' };
    }
    if (/(本月|这个月)/.test(q)) {
      const prefix = isoDay(new Date(lastMs)).slice(0, 7);
      return { trades: cs.filter((t) => (t.closeTime as string).slice(0, 7) === prefix), label: `本月（${prefix}）` };
    }
    return { trades: cs, label: '全部历史' };
  }

  private emptyAnswer(range: RangeResult): Answer {
    return {
      content: `${range.label}范围内没有已平仓交易，我没法凭空给结论。你可以确认一下筛选范围，或者先导入 / 同步数据。`,
      facts: [{ label: '范围', value: range.label }],
      tradeRefs: [],
      followUps: ['看看总体表现', '最近 30 天怎么样', '我能问什么'],
      chart: null,
    };
  }

  /* ------------------------------------------------------------ 各意图答复 */

  private aGreeting(range: RangeResult, memories: MemoryDto[]): Answer {
    const m = computeCoreMetrics(range.trades);
    const breached = memories.filter((x) => x.status === 'breached');
    const lines: string[] = [];
    lines.push(`我在。${range.label}你共有 ${m.closedTrades} 笔已平仓交易，净盈亏 ${money(m.netPnl)}，胜率 ${pctFmt(m.winRate)}。`);
    if (memories.length > 0 && breached.length > 0) {
      lines.push('');
      lines.push(`先提醒：你给自己定的承诺里，有 ${breached.length} 条当前是破线的——`);
      for (const b of breached) lines.push(`· ${b.content} → ${b.statusText}`);
    }
    lines.push('');
    lines.push('你可以直接问，比如「最近亏损主要集中在哪」「哪个时段最差」「我该先改什么」。');

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: 'Trades', value: String(m.closedTrades) },
        { label: 'Net PNL', value: money(m.netPnl) },
        { label: 'Win Rate', value: pctFmt(m.winRate) },
      ],
      tradeRefs: [],
      followUps: ['我的胜率和期望值是多少', '最近亏损集中在哪', '我该先改什么'],
      chart: null,
    };
  }

  private aHelp(): Answer {
    return {
      content: [
        '我能做的事，全部基于你库里的真实成交数据，每条结论都会附上可点开核对的交易引用。',
        '',
        '· 表现类：总体表现 / 胜率与期望值 / 最近 N 天或 N 笔怎么样',
        '· 归因类：哪个品种、哪个时段、星期几、哪种入场/出场理由在拖后腿',
        '· 个案类：亏得最多的几笔、赚得最多的几笔、连败记录',
        '· 纪律类：违规明细、报复性交易、错误标签统计',
        '· 行动类：给我一份改进计划、接下来先做什么',
        '· 记忆类：对我「记住：每天最多亏 200」「以后我杠杆不超过 20」，我会长期盯着并对账',
        '',
        '我不预测行情，也不替你下单。我只负责把你的交易行为摆到桌面上。',
      ].join('\n'),
      facts: [],
      tradeRefs: [],
      followUps: ['看看总体表现', '最近 30 天怎么样', '我该先改什么'],
      chart: null,
    };
  }

  private async aRemember(workspaceId: string, q: string): Promise<Answer> {
    const content = q.replace(/^(记住|帮我记住|帮我记一下|请记住|以后我|从今天起我)[:：]?\s*/, '').trim() || q;
    const dto = await this.addMemory(workspaceId, 'GOAL', content);
    const lines = [`记下了：${content}`];
    if (dto.metric && dto.threshold !== null) {
      lines.push('');
      lines.push(`这条我能用数据盯住（${dto.metric} ≤ ${num(dto.threshold, 0)}）。当前对账：`);
      lines.push(`· ${dto.statusText}${dto.status === 'breached' ? ' —— **已经破线**' : ' —— 目前守住了'}`);
    } else {
      lines.push('');
      lines.push('这条我没法自动对账（没解析出可量化的数字），但会在之后的对话里作为你的原则提醒你。');
      lines.push('如果你想要我盯着，可以写成 quantified 的形式，比如「记住：每天最多亏 200」或「记住：杠杆不超过 20」。');
    }
    return {
      content: lines.join('\n'),
      facts: [
        { label: '类型', value: dto.kind },
        { label: '可量化项', value: dto.metric ?? '无' },
        { label: '阈值', value: dto.threshold === null ? '—' : num(dto.threshold, 0) },
      ],
      tradeRefs: [],
      followUps: ['我还有哪些承诺', '看看总体表现'],
      chart: null,
    };
  }

  private aMemoryList(memories: MemoryDto[]): Answer {
    if (memories.length === 0) {
      return {
        content: '你还没让我记任何东西。可以直接说「记住：每天最多亏 200」，我会长期盯着并对账。',
        facts: [],
        tradeRefs: [],
        followUps: ['记住：每天最多亏 200', '看看总体表现'],
        chart: null,
      };
    }
    const lines = [`你目前有 ${memories.length} 条承诺 / 原则：`];
    for (const mm of memories) {
      lines.push(`· ${mm.content}${mm.statusText ? ` —— ${mm.statusText}${mm.status === 'breached' ? ' ⚠ 已破线' : ' ✓'}` : ''}`);
    }
    return {
      content: lines.join('\n'),
      facts: memories.map((mm, i) => ({ label: `#${i + 1} ${mm.kind}`, value: mm.statusText ?? '仅提醒' })),
      tradeRefs: [],
      followUps: ['最近 30 天怎么样', '我该先改什么'],
      chart: null,
    };
  }

  private async aViolation(workspaceId: string, range: RangeResult, all: UnifiedTrade[]): Promise<Answer> {
    void all;
    const db = this.repo.db;
    const rows = await db
      .select({
        tradeId: tradeViolationsTable.tradeId,
        ruleId: tradeViolationsTable.ruleId,
        detail: tradeViolationsTable.detail,
        ruleName: rulesTable.name,
      })
      .from(tradeViolationsTable)
      .innerJoin(rulesTable, eq(rulesTable.id, tradeViolationsTable.ruleId))
      .where(eq(tradeViolationsTable.workspaceId, workspaceId));

    if (rows.length === 0) {
      return {
        content: '当前没有任何违规记录——要么你守得很稳，要么规则还没跑过评估。可以在「规则」页点评估，让引擎把历史交易全过一遍。',
        facts: [{ label: '违规记录', value: '0 条' }],
        tradeRefs: [],
        followUps: ['报复性交易多吗', '给我一份改进计划'],
        chart: null,
      };
    }

    const byRule = new Map<string, { name: string; count: number; refs: string[] }>();
    for (const r of rows) {
      const cur = byRule.get(r.ruleId) ?? { name: r.ruleName, count: 0, refs: [] };
      cur.count += 1;
      if (cur.refs.length < 20) cur.refs.push(r.tradeId);
      byRule.set(r.ruleId, cur);
    }
    const sorted = [...byRule.values()].sort((a, b) => b.count - a.count);
    const total = rows.length;

    const lines = [`共 ${total} 条违规记录，涉及 ${sorted.length} 条规则：`];
    for (const s of sorted) lines.push(`· ${s.name}：${s.count} 次`);
    lines.push('');
    lines.push(`最常破的是「${sorted[0].name}」——这不是意志力问题，是规则参数和你的实际操作习惯不匹配，要么改规则阈值，要么改出手条件。`);

    return {
      content: lines.join('\n'),
      facts: [
        { label: '违规总数', value: String(total) },
        { label: '涉及规则', value: String(sorted.length) },
        { label: '最高频', value: `${sorted[0].name}（${sorted[0].count} 次）` },
        { label: '范围', value: range.label },
      ],
      tradeRefs: sorted[0].refs,
      followUps: ['我该先改什么', '报复性交易多吗'],
      chart: { type: 'bars', title: '各规则违规次数', unit: '次', data: sorted.map((s) => ({ label: s.name, value: s.count })) },
    };
  }

  private aRevenge(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const strict = detectRevengeTrades(ts, { requireLargerSize: true });
    const loose = detectRevengeTrades(ts, { requireLargerSize: false });
    const lines: string[] = [];
    lines.push(`${range.label}：宽松口径（任一 loss 后 60 分钟内再开仓）${loose.count} 笔，合计 ${money(loose.pnl)}；`);
    lines.push(`严格口径（还要求仓位比上一笔更大，更像「上头加仓」）${strict.count} 笔，合计 ${money(strict.pnl)}。`);
    lines.push('');
    if (strict.count > 0) {
      const share = ts.reduce((a, t) => (t.netPnl < 0 ? a + t.netPnl : a), 0);
      lines.push(
        `严格口径这 ${strict.count} 笔占了同期全部亏损的 ${pctFmt(share === 0 ? 0 : strict.pnl / share)}——这是可以从账面上直接检出来的情绪成本。`,
      );
      lines.push('建议做成硬约束：单笔亏损后 N 分钟内禁止新开仓，仓位不得大于上一笔。');
    } else {
      lines.push('严格口径下没有检出「上头加仓」，说明你在连亏后至少没有习惯性放大仓位——这是好事。');
    }

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '宽松口径', value: `${loose.count} 笔 / ${money(loose.pnl)}` },
        { label: '严格口径', value: `${strict.count} 笔 / ${money(strict.pnl)}` },
      ],
      tradeRefs: strict.tradeRefs,
      followUps: ['给我一份改进计划', '看看总体表现'],
      chart: null,
    };
  }

  private aStreak(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    let curSign = 0;
    let curLen = 0;
    let worstLose = 0;
    let worstLoseStart: string | null = null;
    let bestWin = 0;
    let thisSign = 0;
    let thisLen = 0;
    for (const t of ts) {
      const sign = t.netPnl > 0 ? 1 : t.netPnl < 0 ? -1 : 0;
      if (sign === 0) continue;
      if (sign === curSign) curLen += 1;
      else {
        curSign = sign;
        curLen = 1;
      }
      if (sign < 0 && curLen > worstLose) {
        worstLose = curLen;
        worstLoseStart = (t.closeTime as string).slice(0, 10);
      }
      if (sign > 0 && curLen > bestWin) bestWin = curLen;
      thisSign = curSign;
      thisLen = curLen;
    }
    const lines = [
      `${range.label}：最长连败 ${worstLose} 笔${worstLoseStart ? `（结束于 ${worstLoseStart}）` : ''}，最长连胜 ${bestWin} 笔。`,
      '',
    ];
    if (thisSign < 0) {
      lines.push(`注意：**你现在正处在 ${thisLen} 连亏之中**。历史上你在连亏状态下继续加手的概率是值得看的——先去查回应式交易。`);
    } else {
      lines.push(`当前处在 ${thisLen} 连${thisSign > 0 ? '盈' : '平'}状态。`);
    }

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '最长连败', value: `${worstLose} 笔` },
        { label: '最长连胜', value: `${bestWin} 笔` },
        { label: '当前状态', value: `${thisLen} 连${thisSign > 0 ? '盈' : thisSign < 0 ? '亏' : '平'}` },
      ],
      tradeRefs: [],
      followUps: ['报复性交易多吗', '亏得最多的几笔是哪些'],
      chart: null,
    };
  }

  private aMistake(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const stats = aggregateByMistake(ts).sort((a, b) => a.pnl - b.pnl);
    if (stats.length === 0) {
      return {
        content: `${range.label}没有任何交易打了错误标签。错误标签要自己在交易详情里补——不补的话，这部分就永远只能靠段统计猜。`,
        facts: [{ label: '范围', value: range.label }],
        tradeRefs: [],
        followUps: ['哪个品种最拖后腿', '我该先改什么'],
        chart: null,
      };
    }
    const worst = stats[0];
    const lines = [
      `${range.label}共打了 ${stats.length} 类错误标签，最贵的一类是「${worst.label}」：${worst.trades} 笔，合计 ${money(worst.pnl)}，平均每笔 ${money(worst.expectancy)}。`,
      '',
    ];
    const total = ts.reduce((a, t) => a + t.netPnl, 0);
    lines.push(`它吃掉同期净盈亏的 ${pctFmt(total === 0 ? 0 : Math.abs(worst.pnl) / Math.abs(total))}。去掉它，你的账面会完全不一样。`);

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '最贵错误', value: worst.label },
        { label: '笔数 / 盈亏', value: `${worst.trades} 笔 / ${money(worst.pnl)}` },
        { label: '平均单笔', value: money(worst.expectancy) },
      ],
      tradeRefs: refsFor(ts, (t) => (t.mistakes ?? []).includes(worst.key)),
      followUps: ['我该先改什么', '看看总体表现'],
      chart: {
        type: 'bars',
        title: '错误标签盈亏贡献',
        unit: 'USDT',
        data: stats.slice(0, 8).map((s) => ({ label: s.label, value: Number(s.pnl.toFixed(2)) })),
      },
    };
  }

  private buildTagAnswer(
    range: RangeResult,
    kind: 'entry' | 'exit',
    title: string,
  ): Answer {
    const ts = range.trades;
    const has = ts.filter((t) => (kind === 'entry' ? (t.entryTags ?? []).length > 0 : (t.exitTags ?? []).length > 0));
    if (has.length === 0) {
      return {
        content: `${range.label}内没有任何交易打了${title}。${
          kind === 'entry' ? '入场' : '出场'
        }理由是归因的地基——不填，所有「我做错了什么」都只能停在品种和时段这种粗粒度上。`,
        facts: [{ label: '范围', value: range.label }, { label: `已打${title}`, value: '0 笔' }],
        tradeRefs: [],
        followUps: ['哪个品种最拖后腿', '我该先改什么'],
        chart: null,
      };
    }
    const mapped = has.map((t) => ({ ...t, tags: kind === 'entry' ? t.entryTags ?? [] : t.exitTags ?? [] }));
    const stats = aggregateByTag(mapped).sort((a, b) => b.pnl - a.pnl);
    const best = stats[0];
    const worst = stats[stats.length - 1];
    const covered = has.length;
    const total = ts.length;

    const lines = [
      `${range.label}有 ${covered}/${total} 笔打了${title}（覆盖率 ${pctFmt(covered / total)}），` +
        `共 ${stats.length} 类。`,
      '',
      `最赚钱的一类：「${best.label}」—— ${best.trades} 笔，${money(best.pnl)}，胜率 ${pctFmt(best.winRate)}，EV ${money(best.expectancy)}。`,
    ];
    if (worst && worst.key !== best.key) {
      lines.push(`最亏的一类：「${worst.label}」—— ${worst.trades} 笔，${money(worst.pnl)}，胜率 ${pctFmt(worst.winRate)}，EV ${money(worst.expectancy)}。`);
    }
    lines.push('');
    lines.push(`结论很直接：多做「${best.label}」，砍掉「${worst.key !== best.key ? worst.label : best.label}」。样本只有自己填的才有意义——覆盖率越低，这些数字越不可信。`);

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '覆盖率', value: `${covered}/${total}（${pctFmt(covered / total)}）` },
        { label: `最佳${title}`, value: best.label },
        { label: `最差${title}`, value: worst.key !== best.key ? worst.label : '—' },
      ],
      tradeRefs: refsFor(has, (t) => (kind === 'entry' ? t.entryTags ?? [] : t.exitTags ?? []).includes(best.key)),
      followUps: [kind === 'entry' ? '出场理由表现如何' : '入场理由表现如何', '我该先改什么'],
      chart: {
        type: 'bars',
        title: `${title}盈亏贡献`,
        unit: 'USDT',
        data: stats.slice(0, 8).map((s) => ({ label: s.label, value: Number(s.pnl.toFixed(2)) })),
      },
    };
  }

  private aEntry(range: RangeResult): Answer {
    return this.buildTagAnswer(range, 'entry', '入场理由');
  }

  private aExit(range: RangeResult): Answer {
    return this.buildTagAnswer(range, 'exit', '出场理由');
  }

  private aSymbol(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const stats = aggregateBySymbol(ts).sort((a, b) => b.pnl - a.pnl);
    const best = stats[0];
    const worst = stats[stats.length - 1];
    const lines = [
      `${range.label}共交易 ${stats.length} 个品种。`,
      '',
      `最好做的是「${best.label}」：${best.trades} 笔，${money(best.pnl)}，胜率 ${pctFmt(best.winRate)}，PF ${pfFmt(best.profitFactor ?? Infinity)}。`,
    ];
    if (worst.key !== best.key) {
      lines.push(`最拖后腿的是「${worst.label}」：${worst.trades} 笔，${money(worst.pnl)}，胜率 ${pctFmt(worst.winRate)}，PF ${pfFmt(worst.profitFactor ?? Infinity)}。`);
      lines.push('');
      lines.push('同一个人在不同品种上的表现差距这么大，通常不是技术，是波动率和流动性不匹配你的持仓时长。');
    }
    // 样本量诚实性：几十笔样本算出来的「优势品种」不能当结论用
    if (best.trades < 10) {
      lines.push('');
      lines.push(`注意：「${best.label}」只有 ${best.trades} 笔样本，这个「最好」目前没有统计意义，别据此加仓。`);
    }

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '品种数', value: String(stats.length) },
        { label: '最佳品种', value: `${best.label}（${money(best.pnl)}）` },
        { label: '最差品种', value: worst.key !== best.key ? `${worst.label}（${money(worst.pnl)}）` : '—' },
      ],
      tradeRefs: refsFor(ts, (t) => t.symbol === (worst.key !== best.key ? worst.key : best.key)),
      followUps: ['哪个时段最差', '我该先改什么'],
      chart: {
        type: 'bars',
        title: '各品种净盈亏',
        unit: 'USDT',
        data: stats.slice(0, 10).map((s) => ({ label: s.label, value: Number(s.pnl.toFixed(2)) })),
      },
    };
  }

  private aSession(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const bySession = aggregateByTime(ts, 'session').filter((s) => s.trades > 0).sort((a, b) => b.pnl - a.pnl);
    const byHour = aggregateByTime(ts, 'hour').filter((s) => s.trades > 0).sort((a, b) => b.pnl - a.pnl);
    const best = bySession[0];
    const worst = bySession[bySession.length - 1];
    const lines = [
      `${range.label}按时段看（UTC 时区，Asia 00–08 / London 08–16 / NY 13–21）：`,
      '',
    ];
    for (const s of bySession) {
      lines.push(`· ${s.label}：${s.trades} 笔，${money(s.pnl)}，胜率 ${pctFmt(s.winRate)}`);
    }
    lines.push('');
    if (worst.key !== best.key) {
      lines.push(`${best.label} 赚钱，${worst.label} 亏钱。如果差别稳定，最省力的改法不是优化策略，而是直接不出手。`);
    }
    if (byHour.length > 0) {
      const top3 = byHour.slice(0, 3).map((h) => `${h.label}点(${money(h.pnl)})`);
      const bot3 = byHour.slice(-3).reverse().map((h) => `${h.label}点(${money(h.pnl)})`);
      lines.push('');
      lines.push(`按小时细分：最好 ${top3.join('、')}；最差 ${bot3.join('、')}。`);
    }

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '最佳时段', value: `${best.label}（${money(best.pnl)}）` },
        { label: '最差时段', value: worst.key !== best.key ? `${worst.label}（${money(worst.pnl)}）` : '—' },
        ...(byHour.length > 0
          ? [{ label: '最佳小时', value: byHour[0].label }, { label: '最差小时', value: byHour[byHour.length - 1].label }]
          : []),
      ],
      tradeRefs: [],
      followUps: ['星期几表现最差', '哪个品种最拖后腿'],
      chart: {
        type: 'bars',
        title: '各时段净盈亏',
        unit: 'USDT',
        data: bySession.map((s) => ({ label: s.label, value: Number(s.pnl.toFixed(2)) })),
      },
    };
  }

  private aWorst(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const sorted = [...ts].sort((a, b) => a.netPnl - b.netPnl).slice(0, 5);
    const lines = [`${range.label}亏得最狠的 5 笔：`];
    for (const t of sorted) {
      const sess = getSession(t.closeTime as string);
      lines.push(
        `· ${(t.closeTime as string).slice(0, 16).replace('T', ' ')} ${t.symbol} ${t.side} ${money(t.netPnl)}（${sess} · 持有 ${num((new Date(t.closeTime as string).getTime() - new Date(t.openTime).getTime()) / 60000, 0)} 分钟 · ${num(t.leverage, 0)}x）`,
      );
    }
    const sum = sorted.reduce((a, t) => a + t.netPnl, 0);
    const total = ts.reduce((a, t) => a + t.netPnl, 0);
    lines.push('');
    lines.push(`这 5 笔合计 ${money(sum)}，占同期净盈亏的 ${pctFmt(total === 0 ? 0 : Math.abs(sum) / Math.abs(total))}。这个比例越高，说明你的结果越被少数几笔决定——那风控比策略更值钱。`);

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '前 5 大亏损合计', value: money(sum) },
        { label: '占净盈亏', value: pctFmt(total === 0 ? 0 : Math.abs(sum) / Math.abs(total)) },
        { label: '最大单笔亏损', value: money(sorted[0].netPnl) },
      ],
      tradeRefs: sorted.map((t) => t.id),
      followUps: ['连败记录怎么样', '我该先改什么'],
      chart: null,
    };
  }

  private aBest(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const sorted = [...ts].sort((a, b) => b.netPnl - a.netPnl).slice(0, 5);
    const lines = [`${range.label}赚得最多的 5 笔：`];
    for (const t of sorted) {
      const tags = (t.entryTags ?? []).slice(0, 2).join('/');
      lines.push(
        `· ${(t.closeTime as string).slice(0, 16).replace('T', ' ')} ${t.symbol} ${t.side} ${money(t.netPnl)}${tags ? ` · ${tags}` : ''}`,
      );
    }
    const avgHold = sorted.reduce((a, t) => a + (new Date(t.closeTime as string).getTime() - new Date(t.openTime).getTime()) / 60000, 0) / sorted.length;
    lines.push('');
    lines.push(`这 5 笔平均持有 ${num(avgHold, 0)} 分钟。对比一下你亏损单的平均持有时间——如果赚钱单拿得短、亏钱单拿得长，那是典型的处置效应。`);

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '最大单笔盈利', value: money(sorted[0].netPnl) },
        { label: '前 5 平均持有', value: `${num(avgHold, 0)} 分钟` },
      ],
      tradeRefs: sorted.map((t) => t.id),
      followUps: ['亏得最多的几笔是哪些', '我的胜率和期望值是多少'],
      chart: null,
    };
  }

  private aMetrics(range: RangeResult): Answer {
    const m = computeCoreMetrics(range.trades);
    if (m.closedTrades === 0) return this.emptyAnswer(range);
    const lines = [
      `${range.label}的核心指标：`,
      '',
      `· 胜率 ${pctFmt(m.winRate)}，EV（每笔净期望）${money(m.expectancy)}，盈亏因子 ${pfFmt(m.profitFactor)}`,
      `· 平均盈利 ${money(m.avgWin)} / 平均亏损 ${money(-m.avgLoss)}，实际盈亏比 ${m.avgLoss === 0 ? '∞' : num(Math.abs(m.avgWin / m.avgLoss), 2)}`,
      `· 手续费 ${num(m.fees, 2)}，资金费 ${num(m.funding, 2)}——这两项合计占毛利的 ${pctFmt(m.grossProfit === 0 ? 0 : (m.fees + m.funding) / Math.abs(m.grossProfit))}`,
      '',
    ];
    if (m.expectancy < 0 && m.winRate > 0.5) {
      lines.push('这里有个典型组合：**胜率过半但期望值为负**。说明你在用小赚换大亏——高胜率本身不构成优势，平均亏损远大于平均盈利时会把账户慢慢磨死。');
    } else if (m.expectancy > 0) {
      lines.push('期望值为正，说明体系本身是有统计优势的，剩下的变量是执行一致性，不是找新策略。');
    } else {
      lines.push('期望值为负，样本还没有统计优势——这时候加仓位只会加速亏损。');
    }

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: 'Trades', value: String(m.closedTrades) },
        { label: 'Win Rate', value: pctFmt(m.winRate) },
        { label: 'EV', value: money(m.expectancy) },
        { label: 'Profit Factor', value: pfFmt(m.profitFactor) },
        { label: 'Net PNL', value: money(m.netPnl) },
        { label: 'Avg Win / Avg Loss', value: `${money(m.avgWin)} / ${money(-m.avgLoss)}` },
        { label: 'Largest Loss', value: money(m.largestLoss) },
      ],
      tradeRefs: [],
      followUps: ['我该先改什么', '最近亏损集中在哪'],
      chart: null,
    };
  }

  private aPlan(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const plan = buildImprovementPlan(ts);
    const lines = [`基于${range.label}的 ${plan.recentTrades} 笔交易（近 30 天，净盈亏 ${money(plan.recentNetPnl)}），我的建议按顺序是：`];
    plan.rules.slice(0, 4).forEach((r, i) => {
      lines.push('');
      lines.push(`${i + 1}. ${r.title}`);
      lines.push(`   ${r.detail}`);
      if (r.evidence.length > 0) lines.push(`   依据：${r.evidence[0]}`);
    });
    lines.push('');
    lines.push('别一次全改。一次只改一条，跑够 30 笔再看有没有用——同时改三条的话，你不会知道到底哪条起效。');

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: '近 30 天笔数', value: String(plan.recentTrades) },
        { label: '近 30 天净盈亏', value: money(plan.recentNetPnl) },
        { label: '建议条数', value: String(plan.rules.length) },
      ],
      tradeRefs: [],
      followUps: ['最近 30 天怎么样', '违规多吗'],
      chart: null,
    };
  }

  private aRecent(range: RangeResult): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const m = computeCoreMetrics(ts);
    const byDay = aggregateByTime(ts, 'day').slice(-14);
    const sessions = aggregateByTime(ts, 'session').filter((s) => s.trades > 0).sort((a, b) => b.pnl - a.pnl);
    const symbols = aggregateBySymbol(ts).sort((a, b) => a.pnl - b.pnl);
    const worstSym = symbols[0];

    const bestSession = sessions[0];
    const worstSession = sessions[sessions.length - 1];
    const greenDays = byDay.filter((d) => d.pnl > 0).length;

    const lines = [
      `${range.label}：${m.closedTrades} 笔已平仓，净盈亏 ${money(m.netPnl)}，胜率 ${pctFmt(m.winRate)}，EV ${money(m.expectancy)}。`,
      '',
      `· 近 ${byDay.length} 个交易日里 ${greenDays} 天为正（${pctFmt(byDay.length === 0 ? 0 : greenDays / byDay.length)}）`,
      `· 最好时段 ${bestSession?.label ?? '—'}（${money(bestSession?.pnl ?? 0)}），最差 ${worstSession?.label ?? '—'}（${money(worstSession?.pnl ?? 0)}）`,
      `· 最拖后腿的品种 ${worstSym?.label ?? '—'}（${money(worstSym?.pnl ?? 0)}，${worstSym?.trades ?? 0} 笔）`,
      '',
      m.netPnl < 0
        ? '这段时间整体是净流出的。先别想着优化入场，把最差的那个时段和品种砍掉，账面通常立刻改善。'
        : '这段时间整体为正，重点从「怎么赚钱」切换到「怎么别还回去」——看最大回撤和最大单笔亏损。',
    ];

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: 'Trades', value: String(m.closedTrades) },
        { label: 'Net PNL', value: money(m.netPnl) },
        { label: 'Win Rate', value: pctFmt(m.winRate) },
        { label: 'EV', value: money(m.expectancy) },
        { label: '盈利天数', value: `${greenDays}/${byDay.length}` },
      ],
      tradeRefs: worstSym ? refsFor(ts, (t) => t.symbol === worstSym.key) : [],
      followUps: ['我该先改什么', '亏得最多的几笔是哪些', '哪个时段最差'],
      chart: {
        type: 'bars',
        title: '每日净盈亏（最后 14 天）',
        unit: 'USDT',
        data: byDay.map((d) => ({ label: d.label.slice(5), value: Number(d.pnl.toFixed(2)) })),
      },
    };
  }

  private aOverview(range: RangeResult, memories: MemoryDto[]): Answer {
    const ts = range.trades;
    if (ts.length === 0) return this.emptyAnswer(range);
    const m = computeCoreMetrics(ts);
    const symbols = aggregateBySymbol(ts).sort((a, b) => a.pnl - b.pnl);
    const sessions = aggregateByTime(ts, 'session').filter((s) => s.trades > 0).sort((a, b) => b.pnl - a.pnl);
    const worstSym = symbols[0];
    const bestSession = sessions[0];
    const worstSession = sessions[sessions.length - 1];
    const byDay = aggregateByTime(ts, 'day').slice(-30);
    let cum = 0;
    const curve = byDay.map((d) => {
      cum += d.pnl;
      return { label: d.label.slice(5), value: Number(cum.toFixed(2)) };
    });

    const diagnosis: string[] = [];
    if (m.winRate > 0.5 && m.expectancy < 0) diagnosis.push('胜率过半但 EV 为负：用小赚换大亏，先解决平均亏损远大于平均盈利的问题');
    if (worstSym && worstSym.pnl < 0) diagnosis.push(`${worstSym.label}是当前最大的出血点（${money(worstSym.pnl)}）`);
    if (worstSession && bestSession && worstSession.pnl < 0 && worstSession.key !== bestSession.key)
      diagnosis.push(`${worstSession.label} 时段拖累 ${money(worstSession.pnl)}，而 ${bestSession.label} 赚钱——考虑只在好时段出手`);
    if (m.fees + m.funding > 0 && Math.abs(m.grossProfit) > 0 && (m.fees + m.funding) / Math.abs(m.grossProfit) > 0.3)
      diagnosis.push(`手续费+资金费吃掉毛利的 ${pctFmt((m.fees + m.funding) / Math.abs(m.grossProfit))}，交易频率可能过高`);

    const lines = [
      `${range.label}，${m.closedTrades} 笔已平仓交易，净盈亏 ${money(m.netPnl)}。`,
      '',
      `胜率 ${pctFmt(m.winRate)} · EV ${money(m.expectancy)} · PF ${pfFmt(m.profitFactor)} · 最大单笔亏损 ${money(m.largestLoss)}。`,
      '',
    ];
    if (diagnosis.length > 0) {
      lines.push('我看到的问题：');
      diagnosis.forEach((d, i) => lines.push(`${i + 1}. ${d}`));
    } else {
      lines.push('从数据上暂时没有看到明显的结构性出血点。');
    }
    if (memories.some((x) => x.status === 'breached')) {
      lines.push('');
      lines.push(`另外，你有 ${memories.filter((x) => x.status === 'breached').length} 条承诺已经破线了——进去看一下，别让写下的规则只是装饰。`);
    }

    return {
      content: lines.join('\n'),
      facts: [
        { label: '范围', value: range.label },
        { label: 'Trades', value: String(m.closedTrades) },
        { label: 'Net PNL', value: money(m.netPnl) },
        { label: 'Win Rate', value: pctFmt(m.winRate) },
        { label: 'EV', value: money(m.expectancy) },
        { label: 'Profit Factor', value: pfFmt(m.profitFactor) },
        { label: 'Best Session', value: bestSession ? `${bestSession.label}（${money(bestSession.pnl)}）` : '—' },
        { label: 'Worst Symbol', value: worstSym ? `${worstSym.label}（${money(worstSym.pnl)}）` : '—' },
      ],
      tradeRefs: worstSym ? refsFor(ts, (t) => t.symbol === worstSym.key) : [],
      followUps: ['我该先改什么', '最近亏损集中在哪', '哪个时段最差'],
      chart: { type: 'bars', title: '累计净盈亏曲线（最后 30 个交易日）', unit: 'USDT', data: curve },
    };
  }

  private metaOf(raw: unknown): CoachMeta {
    const m = (raw ?? {}) as Partial<CoachMeta>;
    return {
      facts: Array.isArray(m.facts) ? m.facts : [],
      tradeRefs: Array.isArray(m.tradeRefs) ? m.tradeRefs : [],
      followUps: Array.isArray(m.followUps) ? m.followUps : [],
      chart: (m.chart as CoachChart | null) ?? null,
    };
  }
}

/* ---------------------------------------------------------------- 控制器 */

@Controller('coach')
export class CoachController {
  constructor(private readonly service: CoachService) {}

  @Get('memory')
  memory(@Req() req: Request) {
    return this.service.listMemory(workspaceOf(req));
  }

  @Post('memory')
  addMemory(@Req() req: Request, @Body() body: { kind?: string; content?: string }) {
    return this.service.addMemory(workspaceOf(req), body?.kind ?? 'NOTE', body?.content ?? '');
  }

  @Delete('memory/:id')
  deleteMemory(@Req() req: Request, @Param('id') id: string) {
    return this.service.deleteMemory(workspaceOf(req), id);
  }

  /** 无会话的一次性提问 */
  @Post('ask')
  ask(@Req() req: Request, @Body() body: { content?: string }) {
    return this.service.ask(workspaceOf(req), body?.content ?? '');
  }

  @Get('sessions')
  sessions(@Req() req: Request) {
    return this.service.listSessions(workspaceOf(req));
  }

  @Post('sessions')
  createSession(@Req() req: Request, @Body() body: { title?: string }) {
    return this.service.createSession(workspaceOf(req), body?.title);
  }

  @Get('sessions/:id')
  getSession(@Req() req: Request, @Param('id') id: string) {
    return this.service.getSession(workspaceOf(req), id);
  }

  @Patch('sessions/:id')
  renameSession(@Req() req: Request, @Param('id') id: string, @Body() body: { title?: string }) {
    return this.service.renameSession(workspaceOf(req), id, body?.title ?? '新对话');
  }

  @Delete('sessions/:id')
  deleteSession(@Req() req: Request, @Param('id') id: string) {
    return this.service.deleteSession(workspaceOf(req), id);
  }

  @Post('sessions/:id/messages')
  sendMessage(@Req() req: Request, @Param('id') id: string, @Body() body: { content?: string }) {
    return this.service.sendMessage(workspaceOf(req), id, body?.content ?? '');
  }
}

@Module({
  controllers: [CoachController],
  providers: [CoachService],
  exports: [CoachService],
})
export class CoachModule {}
