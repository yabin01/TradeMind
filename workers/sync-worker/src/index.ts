/**
 * sync-worker：Broker 数据同步（Phase 2 接入交易所 API；Phase 1 为调度骨架）。
 * 队列：sync:initial / sync:incremental / sync:scheduled / sync:webhook
 */
import { Queue, Worker } from 'bullmq';

const connection = { host: process.env.REDIS_HOST ?? '127.0.0.1', port: Number(process.env.REDIS_PORT ?? 6379) };

export const syncQueue = new Queue('sync', { connection });

new Worker(
  'sync',
  async (job) => {
    const { connectionId, kind } = job.data as { connectionId: string; kind: string };
    console.log(`[sync-worker] ${kind} sync for connection ${connectionId}`);
    // Phase 2: 调用 packages/connectors 对应实现 → Raw → Normalizer → UnifiedTrade → dedupe → 入库
    return { ok: true };
  },
  { connection, concurrency: 4 },
);

console.log('[sync-worker] ready');
