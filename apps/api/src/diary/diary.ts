import { Body, Controller, Get, Module, Param, Put, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import { diaryDay, diaryWeek, diaryYear } from '@trademind/analytics';
import { diaryNotes } from '@trademind/database';
import type { FilterSet } from '@trademind/trading-core';
import { createTradeRepo } from '../common/trades-repo';
import { parseFilter, workspaceOf } from '../common/workspace';

export class DiaryService {
  private repo = createTradeRepo();

  /** 加载工作区已平仓交易（Diary 仅统计已平仓），支持 FilterSet（顶栏 API 账户筛选等） */
  private async allClosed(workspaceId: string, filter?: FilterSet) {
    return this.repo.loadTrades(workspaceId, filter);
  }

  async year(workspaceId: string, year: number, filter?: FilterSet) {
    const all = await this.allClosed(workspaceId, filter);
    return diaryYear(all, year);
  }

  async week(workspaceId: string, start: string, filter?: FilterSet) {
    const all = await this.allClosed(workspaceId, filter);
    return diaryWeek(all, start);
  }

  async day(workspaceId: string, date: string, filter?: FilterSet) {
    const all = await this.allClosed(workspaceId, filter);
    return diaryDay(all, date);
  }

  async listNotes(workspaceId: string, scope?: string) {
    const where = scope
      ? and(eq(diaryNotes.workspaceId, workspaceId), eq(diaryNotes.scope, scope))
      : eq(diaryNotes.workspaceId, workspaceId);
    return this.repo.db.select().from(diaryNotes).where(where);
  }

  async upsertNote(
    workspaceId: string,
    body: { scope: string; periodKey: string; rating?: number | null; content?: string | null },
  ) {
    const { scope, periodKey, rating, content } = body;
    if (!scope || !periodKey) throw new Error('scope 与 periodKey 必填');
    const existing = await this.repo.db
      .select()
      .from(diaryNotes)
      .where(and(eq(diaryNotes.workspaceId, workspaceId), eq(diaryNotes.scope, scope), eq(diaryNotes.periodKey, periodKey)));
    if (existing.length > 0) {
      const [row] = await this.repo.db
        .update(diaryNotes)
        .set({ rating: rating ?? null, content: content ?? null, updatedAt: new Date() })
        .where(eq(diaryNotes.id, existing[0].id))
        .returning();
      return row;
    }
    const [row] = await this.repo.db
      .insert(diaryNotes)
      .values({ workspaceId, scope, periodKey, rating: rating ?? null, content: content ?? null })
      .returning();
    return row;
  }
}

@Controller('diary')
export class DiaryController {
  constructor(private readonly service: DiaryService) {}

  @Get(':year')
  year(@Req() req: Request, @Param('year') year: string, @Query('filter') filter?: string) {
    const y = Number(year);
    if (!Number.isFinite(y)) throw new Error('year 必须是数字');
    return this.service.year(workspaceOf(req), y, parseFilter(filter) as FilterSet);
  }

  @Get('week/:start')
  week(@Req() req: Request, @Param('start') start: string, @Query('filter') filter?: string) {
    return this.service.week(workspaceOf(req), start, parseFilter(filter) as FilterSet);
  }

  @Get('day/:date')
  day(@Req() req: Request, @Param('date') date: string, @Query('filter') filter?: string) {
    return this.service.day(workspaceOf(req), date, parseFilter(filter) as FilterSet);
  }
}

@Controller('diary-notes')
export class DiaryNotesController {
  constructor(private readonly service: DiaryService) {}

  @Get()
  list(@Req() req: Request, @Query('scope') scope?: string) {
    return this.service.listNotes(workspaceOf(req), scope);
  }

  @Put()
  upsert(@Req() req: Request, @Body() body: { scope: string; periodKey: string; rating?: number; content?: string }) {
    return this.service.upsertNote(workspaceOf(req), body);
  }
}

@Module({
  controllers: [DiaryController, DiaryNotesController],
  providers: [DiaryService],
})
export class DiaryModule {}
