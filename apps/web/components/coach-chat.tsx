'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { MiniBars } from './mini-bars';

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
  facts?: CoachFact[];
  tradeRefs?: string[];
  followUps?: string[];
  chart?: CoachChart | null;
}

export interface CoachMessage {
  id: string;
  role: string;
  content: string;
  intent: string | null;
  meta: CoachMeta;
  createdAt: string;
}

export interface CoachSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface CoachMemoryItem {
  id: string;
  kind: string;
  content: string;
  metric: string | null;
  threshold: number | null;
  active: boolean;
  createdAt: string;
  status: 'ok' | 'breached' | 'unknown' | null;
  statusText: string | null;
}

const QUICK_PROMPTS = [
  '你好',
  '看看总体表现',
  '最近 30 天怎么样',
  '哪个时段最差',
  '哪个品种最拖后腿',
  '亏得最多的几笔是哪些',
  '连败记录怎么样',
  '我该先改什么',
];

/** 极简 markdown：只处理 **加粗** 与换行，够教练答复用 */
function RichText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
      {parts.map((p, i) =>
        p.startsWith('**') && p.endsWith('**') ? (
          <b key={i} className="text-slate-100">
            {p.slice(2, -2)}
          </b>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  onFollowUp,
}: {
  msg: CoachMessage;
  onFollowUp: (q: string) => void;
}) {
  const isUser = msg.role === 'user';
  const chart = msg.meta?.chart ?? null;
  const facts = msg.meta?.facts ?? [];
  const refs = msg.meta?.tradeRefs ?? [];
  const followUps = msg.meta?.followUps ?? [];

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg border px-3 py-2 ${
          isUser ? 'border-sky-700/50 bg-sky-950/40' : 'border-line bg-surface'
        }`}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap text-sm text-slate-100">{msg.content}</div>
        ) : (
          <RichText text={msg.content} />
        )}

        {!isUser ? (
          <>
            {facts.length > 0 ? (
              <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-line/70 pt-2 text-xs xl:grid-cols-3">
                {facts.map((f, i) => (
                  <div key={i} className="contents">
                    <dt className="text-slate-500">{f.label}</dt>
                    <dd className="text-slate-200">{f.value}</dd>
                  </div>
                ))}
              </dl>
            ) : null}

            {chart ? (
              <div className="mt-2.5 border-t border-line/70 pt-2">
                <div className="mb-1.5 text-xs text-slate-400">
                  {chart.title}（{chart.unit}）
                </div>
                <MiniBars data={chart.data} unit={chart.unit} />
              </div>
            ) : null}

            {refs.length > 0 ? (
              <div className="mt-2.5 border-t border-line/70 pt-2 text-[11px] text-slate-500">
                引用交易 {refs.length} 笔（点开可核对原始记录）：
                <span className="ml-1 flex flex-wrap gap-1">
                  {refs.slice(0, 10).map((id, i) => (
                    <Link
                      key={`${id}-${i}`}
                      href={`/trades/${id}`}
                      className="rounded border border-line px-1.5 py-0.5 text-sky-400 hover:border-sky-600 hover:text-sky-300"
                    >
                      交易 #{i + 1}
                    </Link>
                  ))}
                  {refs.length > 10 ? <span className="px-1 text-slate-600">…</span> : null}
                </span>
              </div>
            ) : null}

            {followUps.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {followUps.map((f) => (
                  <button
                    key={f}
                    onClick={() => onFollowUp(f)}
                    className="rounded-full border border-line px-2.5 py-0.5 text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  >
                    {f}
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function CoachChat() {
  const qc = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sessionsQuery = useQuery({
    queryKey: ['coach-sessions'],
    queryFn: () => api<CoachSession[]>('/coach/sessions'),
  });

  const memoryQuery = useQuery({
    queryKey: ['coach-memory'],
    queryFn: () => api<CoachMemoryItem[]>('/coach/memory'),
  });

  const detailQuery = useQuery({
    queryKey: ['coach-session', activeId],
    queryFn: () => api<{ session: CoachSession; messages: CoachMessage[] }>(`/coach/sessions/${activeId}`),
    enabled: !!activeId,
  });

  // 首次进入：自动选中最近会话，没有则保持空态等待第一条提问
  useEffect(() => {
    const list = sessionsQuery.data;
    if (!list) return;
    if (list.length === 0) {
      setActiveId(null);
      setMessages([]);
      return;
    }
    setActiveId((cur) => (cur && list.some((s) => s.id === cur) ? cur : list[0].id));
  }, [sessionsQuery.data]);

  useEffect(() => {
    if (detailQuery.data) setMessages(detailQuery.data.messages);
  }, [detailQuery.data]);

  useEffect(() => {
    // 新消息出现后滚到底部
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const createSession = useMutation({
    mutationFn: () => api<CoachSession>('/coach/sessions', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['coach-sessions'] });
      setActiveId(s.id);
      setMessages([]);
    },
  });

  const deleteSession = useMutation({
    mutationFn: (id: string) => api<{ deleted: boolean }>(`/coach/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['coach-sessions'] });
      setActiveId(null);
      setMessages([]);
    },
  });

  const deleteMemory = useMutation({
    mutationFn: (id: string) => api<{ deleted: boolean }>(`/coach/memory/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['coach-memory'] }),
  });

  async function ask(text: string) {
    const content = text.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    setInput('');

    // 乐观插入用户气泡
    const optimistic: CoachMessage = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      content,
      intent: null,
      meta: {},
      createdAt: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);

    try {
      let sessionId = activeId;
      if (!sessionId) {
        const s = await api<CoachSession>('/coach/sessions', { method: 'POST', body: JSON.stringify({}) });
        sessionId = s.id;
        setActiveId(s.id);
      }
      const res = await api<{ user: CoachMessage; assistant: CoachMessage }>(
        `/coach/sessions/${sessionId}/messages`,
        { method: 'POST', body: JSON.stringify({ content }) },
      );
      setMessages((m) => [...m.filter((x) => x.id !== optimistic.id), res.user, res.assistant]);
      qc.invalidateQueries({ queryKey: ['coach-sessions'] });
      qc.invalidateQueries({ queryKey: ['coach-memory'] });
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setInput(content);
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const sessions = sessionsQuery.data ?? [];
  const memories = memoryQuery.data ?? [];
  const breached = memories.filter((m) => m.status === 'breached');

  return (
    <div className="flex h-[calc(100vh-9rem)] gap-3">
      {/* 左：会话列表 + 教练记忆 */}
      <div className="flex w-56 shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">会话</span>
          <button
            onClick={() => createSession.mutate()}
            disabled={createSession.isPending}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-slate-300 hover:border-slate-500 disabled:opacity-40"
          >
            + 新对话
          </button>
        </div>

        <div className="flex-1 space-y-1 overflow-y-auto">
          {sessions.length === 0 ? (
            <p className="px-1 text-[11px] text-slate-600">还没有会话，直接提问即可开始。</p>
          ) : null}
          {sessions.map((s) => (
            <div key={s.id} className="group flex items-center gap-1">
              <button
                onClick={() => setActiveId(s.id)}
                className={`flex-1 truncate rounded px-2 py-1.5 text-left text-xs ${
                  activeId === s.id ? 'bg-surface text-slate-100' : 'text-slate-400 hover:bg-surface/60'
                }`}
                title={s.title}
              >
                {s.title}
                <span className="ml-1 text-[10px] text-slate-600">{s.messageCount}</span>
              </button>
              <button
                onClick={() => deleteSession.mutate(s.id)}
                className="hidden text-[11px] text-slate-600 hover:text-down group-hover:block"
                title="删除会话"
              >
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="border-t border-line pt-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs text-slate-500">教练记忆</span>
            {breached.length > 0 ? (
              <span className="rounded bg-down/15 px-1.5 text-[10px] text-down">{breached.length} 条破线</span>
            ) : null}
          </div>
          <div className="max-h-40 space-y-1 overflow-y-auto">
            {memories.length === 0 ? (
              <p className="text-[11px] text-slate-600">试着说「记住：每天最多亏 200」</p>
            ) : null}
            {memories.map((m) => (
              <div key={m.id} className="group rounded border border-line/70 px-2 py-1">
                <div className="flex items-start gap-1">
                  <span className={`text-[10px] ${m.status === 'breached' ? 'text-down' : 'text-up'}`}>
                    {m.status === 'breached' ? '✕' : '✓'}
                  </span>
                  <span className="flex-1 text-[11px] text-slate-300">{m.content}</span>
                  <button
                    onClick={() => deleteMemory.mutate(m.id)}
                    className="hidden text-[10px] text-slate-600 hover:text-down group-hover:block"
                  >
                    ✕
                  </button>
                </div>
                {m.statusText ? <p className="mt-0.5 pl-3 text-[10px] text-slate-500">{m.statusText}</p> : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右：对话区 */}
      <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-panel">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
          {messages.length === 0 ? (
            <div className="space-y-3 py-6">
              <p className="text-center text-sm text-slate-400">
                我是你的交易教练。问我任何关于你交易行为的问题——所有答案都来自你库里的真实成交。
              </p>
              <div className="flex flex-wrap justify-center gap-1.5">
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q}
                    onClick={() => ask(q)}
                    className="rounded-full border border-line px-2.5 py-1 text-[11px] text-slate-400 hover:border-slate-500 hover:text-slate-200"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((m) => (
            <MessageBubble key={m.id} msg={m} onFollowUp={ask} />
          ))}

          {sending ? (
            <div className="flex justify-start">
              <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-slate-500">
                正在翻你的成交记录…
              </div>
            </div>
          ) : null}

          {error ? <p className="text-xs text-down">{error}</p> : null}
        </div>

        <div className="border-t border-line p-2">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void ask(input);
                }
              }}
              rows={2}
              placeholder="问点什么？Enter 发送，Shift+Enter 换行"
              className="flex-1 resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm text-slate-200 outline-none placeholder:text-slate-600 focus:border-slate-500"
            />
            <button
              onClick={() => void ask(input)}
              disabled={sending || input.trim() === ''}
              className="rounded-md bg-sky-600 px-3 py-2 text-sm text-white hover:bg-sky-500 disabled:opacity-40"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
