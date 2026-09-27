'use client';

import { useState } from 'react';
import { CoachChat } from '../../components/coach-chat';
import { CounterfactualPanel } from '../../components/counterfactual-panel';

type Tab = 'chat' | 'deep';

export default function AiCoachPage() {
  const [tab, setTab] = useState<Tab>('chat');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-medium">AI 教练</h2>
        <div className="flex rounded-md border border-line p-0.5 text-xs">
          <button
            onClick={() => setTab('chat')}
            className={`rounded px-2.5 py-1 ${tab === 'chat' ? 'bg-surface text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
          >
            对话教练
          </button>
          <button
            onClick={() => setTab('deep')}
            className={`rounded px-2.5 py-1 ${tab === 'deep' ? 'bg-surface text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
          >
            深度推演
          </button>
        </div>
        <p className="ml-auto hidden text-xs text-slate-500 lg:block">
          AI 不负责下单，只负责分析。所有结论均由数据库聚合计算并附交易引用——不虚构数据。
        </p>
      </div>

      {tab === 'chat' ? <CoachChat /> : <CounterfactualPanel />}
    </div>
  );
}
