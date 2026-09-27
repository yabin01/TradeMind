import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Module,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { rules as rulesTable, tradeViolations as violationsTable } from '@trademind/database';
import {
  RULE_TYPES,
  defaultRules,
  evaluateRules,
  ruleTemplates,
  summarizeViolations,
  suggestRules,
  type RuleDef,
  type RuleType,
} from '@trademind/analytics';
import { createTradeRepo } from '../common/trades-repo';
import { workspaceOf } from '../common/workspace';

type RuleRow = typeof rulesTable.$inferSelect;

const ALLOWED_TYPES = new Set<string>(RULE_TYPES.map((r) => r.type));

function toDef(row: RuleRow): RuleDef {
  return {
    id: row.id,
    name: row.name,
    type: row.type as RuleType,
    enabled: row.enabled,
    params: (row.params as Record<string, unknown>) ?? {},
  };
}

function toDefs(rows: RuleRow[]): RuleDef[] {
  return rows.filter((r) => ALLOWED_TYPES.has(r.type)).map(toDef);
}

export class RulesService implements OnModuleInit {
  private repo = createTradeRepo();

  /** 服务启动时确保 demo 工作区有一套默认规则，避免用户第一次进页面是空的 */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureDefaults('22222222-2222-2222-2222-222222222222');
    } catch {
      // 启动期 DB 不可用时静默，首次请求会重试
    }
  }

  async ensureDefaults(workspaceId: string) {
    const rows = await this.repo.db
      .select()
      .from(rulesTable)
      .where(eq(rulesTable.workspaceId, workspaceId));
    if (rows.length > 0) return rows;
    const inserted = await this.repo.db
      .insert(rulesTable)
      .values(defaultRules().map((d) => ({ ...d, workspaceId })))
      .returning();
    return inserted;
  }

  async list(workspaceId: string) {
    await this.ensureDefaults(workspaceId);
    const rows = await this.repo.db
      .select()
      .from(rulesTable)
      .where(eq(rulesTable.workspaceId, workspaceId));
    return rows;
  }

  async create(
    workspaceId: string,
    body: { name: string; type: string; params?: unknown; enabled?: boolean },
  ) {
    const type = String(body.type ?? '');
    if (!ALLOWED_TYPES.has(type)) {
      throw new HttpException(
        `未知规则类型：${type}（可用：${RULE_TYPES.map((r) => r.type).join(', ')}）`,
        400,
      );
    }
    if (!body.name?.trim()) throw new HttpException('请填写规则名称', 400);
    const [row] = await this.repo.db
      .insert(rulesTable)
      .values({
        workspaceId,
        name: body.name.trim(),
        type,
        enabled: body.enabled !== false,
        params: (body.params ?? {}) as Record<string, unknown>,
      })
      .returning();
    return row;
  }

  async update(
    workspaceId: string,
    id: string,
    body: { name?: string; enabled?: boolean; params?: unknown; type?: string },
  ) {
    const patch: Partial<typeof rulesTable.$inferInsert> = {};
    if (body.name !== undefined) patch.name = body.name.trim();
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.params !== undefined) patch.params = body.params as Record<string, unknown>;
    if (body.type !== undefined) {
      if (!ALLOWED_TYPES.has(body.type)) throw new HttpException(`未知规则类型：${body.type}`, 400);
      patch.type = body.type;
    }
    if (Object.keys(patch).length === 0) throw new HttpException('没有需要更新的字段', 400);
    const [row] = await this.repo.db
      .update(rulesTable)
      .set(patch)
      .where(and(eq(rulesTable.id, id), eq(rulesTable.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpException('规则不存在', 404);
    return row;
  }

  /** 删除规则（违规记录靠 FK cascade 一并清理） */
  async remove(workspaceId: string, id: string) {
    const [row] = await this.repo.db
      .delete(rulesTable)
      .where(and(eq(rulesTable.id, id), eq(rulesTable.workspaceId, workspaceId)))
      .returning();
    if (!row) throw new HttpException('规则不存在', 404);
    return { deleted: true, id };
  }

  /**
   * 评估并落库：
   *   - 先清空本工作区由「当前规则集」产生的违规（保留已删除规则的孤儿记录会被 FK 清掉）
   *   - 再按 (tradeId, ruleId) 唯一约束批量写入
   * 幂等：重复评估结果一致。
   */
  async evaluate(workspaceId: string) {
    const trades = await this.repo.loadTrades(workspaceId);
    const rows = await this.repo.db
      .select()
      .from(rulesTable)
      .where(eq(rulesTable.workspaceId, workspaceId));
    const defs = toDefs(rows);
    const violations = evaluateRules(trades, defs);
    const summary = summarizeViolations(trades, violations);

    // 清空本工作区旧违规（规则被停用/改阈值后，旧标记必须消失，否则会误导）
    const ruleIds = rows.map((r) => r.id);
    if (ruleIds.length > 0) {
      await this.repo.db
        .delete(violationsTable)
        .where(
          and(
            eq(violationsTable.workspaceId, workspaceId),
            inArray(violationsTable.ruleId, ruleIds),
          ),
        );
    }

    if (violations.length > 0) {
      await this.repo.db
        .insert(violationsTable)
        .values(
          violations.map((v) => ({
            workspaceId,
            tradeId: v.tradeId,
            ruleId: v.ruleId,
            detail: v.detail,
          })),
        )
        .onConflictDoNothing();
    }

    return {
      evaluatedAt: new Date().toISOString(),
      trades: trades.length,
      rules: defs.length,
      enabledRules: defs.filter((d) => d.enabled).length,
      ...summary,
    };
  }

  /**
   * 基于用户真实历史推荐阈值（分位数口径），避免「通用默认值命中 99% 交易」的废规则。
   */
  async suggest(workspaceId: string) {
    const trades = await this.repo.loadTrades(workspaceId);
    const suggestions = suggestRules(trades);
    return {
      trades: trades.length,
      closedTrades: trades.filter((t) => t.closeTime !== null).length,
      suggestions,
    };
  }

  /**
   * 用推荐阈值替换现有规则（会删除当前全部规则及其违规记录）。
   * 前端需二次确认后才调用。
   */
  async applySuggestions(workspaceId: string) {
    const trades = await this.repo.loadTrades(workspaceId);
    const suggestions = suggestRules(trades);
    if (suggestions.length === 0) {
      throw new HttpException('暂无交易数据，无法生成推荐阈值', 400);
    }
    await this.repo.db.delete(rulesTable).where(eq(rulesTable.workspaceId, workspaceId));
    const inserted = await this.repo.db
      .insert(rulesTable)
      .values(
        suggestions.map((s) => ({
          workspaceId,
          name: s.name,
          type: s.type,
          enabled: s.enabled,
          params: s.params,
        })),
      )
      .returning();
    const result = await this.evaluate(workspaceId);
    return { rules: inserted, evaluation: result };
  }

  /** 违规明细（带交易摘要，供前端列表跳转核对） */
  async violations(workspaceId: string, opts: { limit?: number } = {}) {
    const limit = opts.limit ?? 200;
    const rows = await this.repo.db
      .select({
        id: violationsTable.id,
        tradeId: violationsTable.tradeId,
        ruleId: violationsTable.ruleId,
        detail: violationsTable.detail,
        createdAt: violationsTable.createdAt,
      })
      .from(violationsTable)
      .where(eq(violationsTable.workspaceId, workspaceId))
      .limit(limit);
    const ruleRows = await this.repo.db
      .select()
      .from(rulesTable)
      .where(eq(rulesTable.workspaceId, workspaceId));
    const ruleMap = new Map(ruleRows.map((r) => [r.id, r]));

    const trades = await this.repo.loadTrades(workspaceId);
    const tradeMap = new Map(trades.map((t) => [t.id, t]));

    return rows.map((r) => {
      const rule = ruleMap.get(r.ruleId);
      const t = tradeMap.get(r.tradeId);
      return {
        ...r,
        ruleName: rule?.name ?? '（规则已删除）',
        ruleType: rule?.type ?? null,
        trade: t
          ? {
              symbol: t.symbol,
              side: t.side,
              positionSide: t.positionSide,
              netPnl: t.netPnl,
              leverage: t.leverage,
              openTime: t.openTime,
              closeTime: t.closeTime,
            }
          : null,
      };
    });
  }
}

@Controller('rules')
export class RulesController {
  constructor(private readonly service: RulesService) {}

  /** 规则类型元数据（供前端渲染表单） */
  @Get('meta')
  meta() {
    return RULE_TYPES;
  }

  /** 规则模板库：每种规则类型给出一套可直接应用的默认参数 */
  @Get('templates')
  templates() {
    return ruleTemplates();
  }

  @Get()
  list(@Req() req: Request) {
    return this.service.list(workspaceOf(req));
  }

  @Post()
  create(
    @Req() req: Request,
    @Body() body: { name: string; type: string; params?: unknown; enabled?: boolean },
  ) {
    return this.service.create(workspaceOf(req), body);
  }

  @Patch(':id')
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { name?: string; enabled?: boolean; params?: unknown; type?: string },
  ) {
    return this.service.update(workspaceOf(req), id, body);
  }

  @Delete(':id')
  remove(@Req() req: Request, @Param('id') id: string) {
    return this.service.remove(workspaceOf(req), id);
  }

  /** 基于真实历史推荐阈值（含命中预估与依据） */
  @Get('suggest')
  suggest(@Req() req: Request) {
    return this.service.suggest(workspaceOf(req));
  }

  /** 采用推荐阈值（替换现有规则并立即评估） */
  @Post('apply-suggestions')
  applySuggestions(@Req() req: Request) {
    return this.service.applySuggestions(workspaceOf(req));
  }

  /** 评估全部规则并写入违规（幂等） */
  @Post('evaluate')
  evaluate(@Req() req: Request) {
    return this.service.evaluate(workspaceOf(req));
  }

  /** 违规明细列表 */
  @Get('violations')
  violations(@Req() req: Request) {
    return this.service.violations(workspaceOf(req));
  }
}

@Module({
  controllers: [RulesController],
  providers: [RulesService],
  exports: [RulesService],
})
export class RulesModule {}
