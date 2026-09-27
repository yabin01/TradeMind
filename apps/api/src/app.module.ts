import { Module } from '@nestjs/common';
import { TradesModule } from './trades/trades';
import { AnalyticsModule } from './analytics/analytics';
import { ConnectionsModule } from './connections/connections';
import { AiModule } from './ai/ai';
import { RulesModule } from './rules/rules';
import { DiaryModule } from './diary/diary';
import { ReferencesModule } from './references/references';
import { CoachModule } from './coach/coach';
import { PositionsModule } from './positions/positions';

@Module({
  imports: [
    TradesModule,
    AnalyticsModule,
    ConnectionsModule,
    AiModule,
    RulesModule,
    DiaryModule,
    ReferencesModule,
    CoachModule,
    PositionsModule,
  ],
})
export class AppModule {}
