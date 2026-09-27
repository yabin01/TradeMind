/**
 * ai-worker：AI 报告生成（每日复盘 / 策略报告 / 模式检测定时任务）。
 * Phase 3 接入 LLM；Phase 1 规则引擎已在 API 层实现，worker 负责定时触发。
 */
import { Worker } from 'bullmq';

const connection = { host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379) };

new Worker(
  'ai',
  async (job) => {
    const { kind, workspaceId } = job.data as { kind: string; workspaceId: string };
    console.log(`[ai-worker] ${kind} for workspace ${workspaceId}`);
    // Phase 3: 调用 packages/ai 生成 Daily Review / Strategy Report，写入 ai_reports
    return { ok: true };
  },
  { connection, concurrency: 1 },
);

console.log('[ai-worker] ready');
