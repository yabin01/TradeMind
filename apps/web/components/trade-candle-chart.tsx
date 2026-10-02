'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { api } from '../lib/api';
import { Section } from './ui';
import { fmtTs } from '../lib/format';
import { useAppearance } from '../lib/use-appearance';

/**
 * 单笔交易持仓期间的 K 线图（开仓 / 平仓对照）。
 *
 * 数据来自后端 /trades/:id/candles（交易所公开行情，不碰用户 API Key）。
 * 图表用 TradingView lightweight-charts，配色跟随外观设置（默认红涨绿跌）。
 *
 * 三个必须遵守的约定（踩过才知道）：
 *   1. **标注时间必须落在返回的 K 线里**，否则 lightweight-charts 会把整条标注静默丢掉。
 *      后端已经把开仓/平仓时间吸附到所属 K 线开盘时间，前端不再自行换算。
 *   2. **时间轴一律按北京时间显示**（与 OKX 后台一致），数据本身仍是 UTC 秒级时间戳，
 *      只在格式化器里做 +8h 偏移，绝不改数据。
 *   3. **CSS 变量是 RGB 通道串**（"239 68 68"），要用逗号拼成 rgb()/rgba() 才能喂给 canvas。
 */

type CandleBar = '1m' | '5m' | '15m' | '1H' | '4H' | '1D';

interface CandlePoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

interface CandlesPayload {
  available: boolean;
  venue: string;
  reason?: string;
  hint?: string | null;
  instId?: string;
  bar?: CandleBar;
  barOptions?: CandleBar[];
  autoBar?: CandleBar;
  candles?: CandlePoint[];
  entry?: { time: number; price: number };
  exit?: { time: number; price: number } | null;
  isOpen?: boolean;
  span?: { from: number; to: number };
  holdingRange?: { high: number; low: number; amplitudePct: number; exact: boolean } | null;
  warnings?: string[];
}

const BAR_TEXT: Record<CandleBar, string> = {
  '1m': '1分',
  '5m': '5分',
  '15m': '15分',
  '1H': '1时',
  '4H': '4时',
  '1D': '1天',
};

const BEIJING_OFFSET_SEC = 8 * 3600;

/** 坐标轴文字色（slate-500，明暗主题下都可读） */
const AXIS_TEXT: [number, number, number] = [100, 116, 139];
/**
 * 开仓标注固定用蓝色（blue-500）。
 * 不用涨跌色：做空开仓会是绿色、亏损平仓也是绿色，两个标注撞色后根本分不清哪个是哪个。
 */
const ENTRY_COLOR: [number, number, number] = [59, 130, 246];
const ENTRY_CSS = 'rgb(59, 130, 246)';

/** CSS 变量（RGB 通道串）→ 数字三元组；取不到时用兜底值 */
function readChannels(name: string, fallback: [number, number, number]): [number, number, number] {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parts = raw.split(/[\s,]+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return fallback;
  return [parts[0], parts[1], parts[2]];
}
const rgb = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

/** 价格小数位：低价币种给更多位，否则 0.2 和 0.2001 看起来一模一样 */
function pricePrecision(price: number): { precision: number; minMove: number } {
  const p = Math.abs(price);
  const precision = p >= 1000 ? 2 : p >= 100 ? 3 : p >= 1 ? 4 : p >= 0.1 ? 5 : 6;
  return { precision, minMove: Number(`1e-${precision}`) };
}

/** 价格显示：按标的精度保留小数，并去掉无意义的尾零（2628.9999999999995 → 2629） */
function fmtPrice(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '—';
  let s = v.toFixed(precision);
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    const decimals = (s.split('.')[1] ?? '').length;
    if (decimals < Math.min(2, precision)) s = v.toFixed(Math.min(2, precision));
    s = s.replace(/\.$/, '');
  }
  return s;
}

const p2 = (n: number) => String(n).padStart(2, '0');

/** 秒级 UTC 时间戳 → 北京时间的各字段（只在这里做偏移，数据本身保持 UTC） */
function beijingParts(sec: number) {
  const d = new Date((sec + BEIJING_OFFSET_SEC) * 1000);
  return {
    Y: String(d.getUTCFullYear()),
    M: p2(d.getUTCMonth() + 1),
    D: p2(d.getUTCDate()),
    h: p2(d.getUTCHours()),
    m: p2(d.getUTCMinutes()),
    hour: d.getUTCHours(),
  };
}

/** 时间轴刻度：TickMarkType 0=年 1=月 2=日 3=时间 4=带秒时间 */
function tickLabel(time: Time, type: number): string {
  const sec = typeof time === 'number' ? time : 0;
  const b = beijingParts(sec);
  if (type === 0) return b.Y;
  if (type === 1) return `${b.Y}-${b.M}`;
  if (type === 2) return `${b.M}-${b.D}`;
  // 日内刻度：跨零点那根带上日期，避免多日 1 分钟图出现一串相同的 HH:mm
  if (b.hour === 0) return `${b.M}-${b.D}`;
  return `${b.h}:${b.m}`;
}

function fullLabel(sec: number): string {
  const b = beijingParts(sec);
  return `${b.M}-${b.D} ${b.h}:${b.m}`;
}

export function TradeCandleChart({
  tradeId,
  direction,
  netPnl,
}: {
  tradeId: string;
  direction: 'LONG' | 'SHORT';
  netPnl: number;
}) {
  const [bar, setBar] = useState<CandleBar | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [appearance] = useAppearance();

  const { data, isFetching, error } = useQuery({
    queryKey: ['trade-candles', tradeId, bar ?? 'auto'],
    queryFn: () => api<CandlesPayload>(`/trades/${tradeId}/candles${bar ? `?bar=${bar}` : ''}`),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    // 切周期时保留上一张图，避免整块区域闪成占位框
    placeholderData: (prev) => prev,
  });

  const ok = Boolean(data && data.available && data.candles && data.candles.length > 0);
  const candles = data?.candles ?? [];
  const entry = data?.entry;
  const exit = data?.exit ?? null;

  /**
   * 高亮哪个周期按钮：取数过程中先亮用户点的那个（点击即反馈），
   * 取完再回到真实生效的周期 —— 交易所细粒度历史不足时后端会降级，
   * 此时按钮要跟着显示真正画出来的周期，否则会出现「亮着 1 分、画的是 1 小时」。
   */
  const activeBar: CandleBar | undefined = isFetching ? bar ?? data?.bar : data?.bar ?? bar ?? undefined;

  // 外观变化（明暗主题 / 涨跌配色）后需要重建图表，因为颜色是「画」进去的
  const themeKey = `${appearance.theme}|${appearance.pnlUp}|${appearance.pnlDown}`;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ok || !entry) return;

    let chart: IChartApi | null = null;

    const up = readChannels('--pnl-up', [239, 68, 68]);
    const down = readChannels('--pnl-down', [34, 197, 94]);
    const panel = readChannels('--panel', [15, 21, 34]);
    const line = readChannels('--line', [31, 41, 55]);
    const axis = AXIS_TEXT;

    // 开仓固定蓝色，平仓用「结果」色（盈利=涨色 / 亏损=跌色）
    const entryColor = ENTRY_COLOR;
    const exitColor = netPnl >= 0 ? up : down;

    const { precision, minMove } = pricePrecision(entry.price || candles[0]?.close || 1);

    chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: rgb(panel) },
        textColor: rgb(axis),
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: rgba(line, 0.55) },
        horzLines: { color: rgba(line, 0.55) },
      },
      rightPriceScale: { borderColor: rgba(line, 0.9), scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: {
        borderColor: rgba(line, 0.9),
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        tickMarkFormatter: (time: Time, type: number) => tickLabel(time, type),
      },
      localization: {
        locale: 'zh-CN',
        timeFormatter: (time: Time) => fullLabel(time as unknown as number),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { labelBackgroundColor: rgb(line) },
        horzLine: { labelBackgroundColor: rgb(line) },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: rgb(up),
      downColor: rgb(down),
      borderUpColor: rgb(up),
      borderDownColor: rgb(down),
      wickUpColor: rgb(up),
      wickDownColor: rgb(down),
      priceFormat: { type: 'price', precision, minMove },
    });
    series.setData(
      candles.map((c) => ({
        time: c.time as unknown as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );

    // 成交量：贴底、不占价格轴（priceScaleId: '' 表示独立且不显示刻度）
    const hasVolume = candles.some((c) => c.volume !== null && c.volume !== undefined);
    if (hasVolume) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(
        candles.map((c) => ({
          time: c.time as unknown as Time,
          value: c.volume ?? 0,
          color: c.close >= c.open ? rgba(up, 0.32) : rgba(down, 0.32),
        })),
      );
    }

    // 标注：时间已由后端吸附到所属 K 线，这里直接用。
    // 文字只写「开仓 / 平仓」不带价格——带价格的文字框会横跨好几根 K 线，在剧烈行情里根本读不清，
    // 价格已经由右侧价格线标签和下方图例给出。
    const markers: SeriesMarker<Time>[] = [];
    markers.push({
      time: entry.time as unknown as Time,
      position: direction === 'LONG' ? 'belowBar' : 'aboveBar',
      shape: direction === 'LONG' ? 'arrowUp' : 'arrowDown',
      color: rgb(entryColor),
      text: '开仓',
      size: 2,
    });
    if (exit) {
      markers.push({
        time: exit.time as unknown as Time,
        position: direction === 'LONG' ? 'aboveBar' : 'belowBar',
        shape: direction === 'LONG' ? 'arrowDown' : 'arrowUp',
        color: rgb(exitColor),
        text: '平仓',
        size: 2,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, markers);

    // 价格线：把开仓价与平仓价横着拉一条虚线，方便直接比高低
    series.createPriceLine({
      price: entry.price,
      color: rgb(entryColor),
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '开仓价',
    });
    if (exit) {
      series.createPriceLine({
        price: exit.price,
        color: rgb(exitColor),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: '平仓价',
      });
    }

    // 默认视野聚焦在持仓区间（两侧留白仍可拖出来看）
    const t0 = entry.time;
    const t1 = exit ? exit.time : data?.span?.to ?? t0;
    const margin = Math.max((t1 - t0) * 0.12, 120);
    chart.timeScale().setVisibleRange({ from: (t0 - margin) as Time, to: (t1 + margin) as Time });

    return () => {
      chart?.remove();
      chart = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, tradeId, themeKey, direction, netPnl, candles, entry, exit]);

  const legend = useMemo(() => {
    if (!ok || !entry) return null;
    const digits = pricePrecision(entry.price || 1).precision;
    return { entry, exit, range: data?.holdingRange ?? null, digits };
  }, [ok, entry, exit, data]);

  const title = useMemo(() => {
    if (!data) return '持仓期间行情';
    if (!data.available) return `持仓期间行情（${data.venue || '未知来源'}）`;
    return `持仓期间行情 · 开仓 / 平仓对照（${data.venue}）`;
  }, [data]);

  return (
    <Section
      title={title}
      actions={
        data?.available && data.barOptions && data.barOptions.length > 1 ? (
          <div className="flex items-center gap-1">
            {data.barOptions.map((b) => {
              const active = b === activeBar;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBar(b)}
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                    active
                      ? 'bg-slate-500/25 text-slate-100'
                      : 'text-slate-500 hover:bg-slate-500/10 hover:text-slate-300'
                  }`}
                >
                  {BAR_TEXT[b]}
                </button>
              );
            })}
            {isFetching ? <span className="ml-1 text-xs text-slate-500">取数中…</span> : null}
          </div>
        ) : null
      }
    >
      {error ? (
        <p className="text-sm text-down">行情请求失败：{(error as Error).message}</p>
      ) : !data ? (
        <div className="flex h-[360px] items-center justify-center rounded-lg border border-line bg-surface">
          <p className="text-sm text-slate-500">正在向交易所取该笔交易的 K 线…</p>
        </div>
      ) : !data.available ? (
        <div className="space-y-2 rounded-lg border border-line bg-surface px-4 py-6">
          <p className="text-sm text-slate-300">这笔交易没有可用的 K 线图</p>
          <p className="text-xs text-slate-500">{data.reason}</p>
          {data.hint ? <p className="text-xs text-slate-600">{data.hint}</p> : null}
          <p className="text-xs text-slate-600">
            提示：K 线走的是交易所的公开行情接口（只读、免签名），不会使用你的 API Key。
          </p>
        </div>
      ) : (
        <>
          <div ref={containerRef} className="h-[380px] w-full" />

          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
            {legend ? (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: ENTRY_CSS }} />
                  <span className="text-slate-500">开仓</span>
                  <span className="font-mono text-slate-200">{fmtPrice(legend.entry.price, legend.digits)}</span>
                  <span className="text-slate-600">{fmtTs(new Date(legend.entry.time * 1000).toISOString())}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${netPnl >= 0 ? 'bg-up' : 'bg-down'}`}
                  />
                  <span className="text-slate-500">{legend.exit ? '平仓' : '持仓中'}</span>
                  {legend.exit ? (
                    <>
                      <span className="font-mono text-slate-200">{fmtPrice(legend.exit.price, legend.digits)}</span>
                      <span className="text-slate-600">{fmtTs(new Date(legend.exit.time * 1000).toISOString())}</span>
                    </>
                  ) : (
                    <span className="text-slate-600">尚未平仓，图示截至当前</span>
                  )}
                </span>
                {legend.range ? (
                  <span className="text-slate-500">
                    持仓区间高/低
                    <span className="ml-1 font-mono text-slate-300">{fmtPrice(legend.range.high, legend.digits)}</span>
                    <span className="mx-0.5 text-slate-600">/</span>
                    <span className="font-mono text-slate-300">{fmtPrice(legend.range.low, legend.digits)}</span>
                    <span className="ml-2 text-slate-600">
                      振幅 {legend.range.amplitudePct.toFixed(2)}%
                      {legend.range.exact ? '（1分精度）' : '（按所选周期近似）'}
                    </span>
                  </span>
                ) : null}
              </>
            ) : null}
          </div>

          {data.warnings && data.warnings.length > 0 ? (
            <p className="mt-2 text-xs text-amber-400">{data.warnings.join(' ')}</p>
          ) : null}
          <p className="mt-1 text-xs text-slate-600">
            时间轴为北京时间（UTC+8）；开仓/平仓箭头与虚线为该笔的成交点。
            {data.autoBar && data.bar !== data.autoBar
              ? `当前周期为你手动选择的${BAR_TEXT[data.bar as CandleBar]}，自动选择为${BAR_TEXT[data.autoBar]}。`
              : ''}
          </p>
        </>
      )}
    </Section>
  );
}
