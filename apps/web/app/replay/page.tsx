'use client';

export default function ReplayPage() {
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-medium">交易回放</h2>
      <div className="rounded-xl border border-line bg-panel p-8 text-center">
        <p className="text-sm text-slate-400">TradingView 风格回放（Entry / Exit / SL / TP / Position / Price / Time）</p>
        <p className="mt-1 text-xs text-slate-600">第四阶段交付：基于 TradingView Lightweight Charts 的逐笔回放与 1m/5m K 线重放。</p>
      </div>
    </div>
  );
}
