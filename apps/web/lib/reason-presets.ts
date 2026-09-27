/**
 * 入场 / 出场理由预设库
 *
 * 对齐 TraderMake 的 reason presets：把最常见的入场动机与出场动作固化为可一键点选的标签，
 * 避免每笔交易都手打自由文本导致同一动作出现「止损」「止损离场」「stop loss」多种写法，
 * 从而让「按理由聚合」这类分析真正可用。
 *
 * 说明：这些只是 UI 快捷候选，仍然保存为交易上的自由文本标签（entryTags / exitTags），
 * 用户可以照旧输入自定义值。
 */

/** 入场理由预设（20 条） */
export const ENTRY_REASON_PRESETS: string[] = [
  '趋势跟随',
  '突破入场',
  '回踩确认',
  '支撑位做多',
  '阻力位做空',
  '区间高抛低吸',
  '均线金叉',
  '量能放大',
  '背驰信号',
  '缠论一买',
  '缠论二买',
  '缠论三买',
  '中枢突破',
  '二次探底',
  '消息面驱动',
  '联动 BTC',
  '计划内加仓',
  '试仓',
  'FOMO 追单',
  '计划外入场',
];

/** 出场理由预设（18 条，含风险动作） */
export const EXIT_REASON_PRESETS: string[] = [
  '达到目标位',
  '止盈离场',
  '分批减仓',
  '移动止盈',
  '跟踪止损触发',
  '止损离场',
  // 风险动作排在前面，保证在「常用」里默认可见（未展开时也能一键点选）
  '触及风险上限平仓',
  '强平',
  '手动平仓—逻辑失效',
  '手动平仓—情绪化',
  '保本离场',
  '时间止损',
  '信号反转',
  '阻力位减仓',
  '资金费过高',
  '释放保证金',
  '转仓 / 换月',
  '系统或网络问题',
];

/** 风险类出场动作：UI 上高亮为红色，复盘时优先归因 */
export const RISK_EXIT_TAGS: string[] = [
  '强平',
  '触及风险上限平仓',
  '手动平仓—情绪化',
  'FOMO 追单',
  '计划外入场',
];

/** 正向出场动作：UI 上高亮为绿色 */
export const GOOD_EXIT_TAGS: string[] = ['达到目标位', '止盈离场', '移动止盈', '分批减仓', '跟踪止损触发'];

export type TagTone = 'normal' | 'risk' | 'good';

export function tagTone(name: string): TagTone {
  if (RISK_EXIT_TAGS.includes(name)) return 'risk';
  if (GOOD_EXIT_TAGS.includes(name)) return 'good';
  return 'normal';
}

/** 通用标签（非理由）的软建议：用于 trades 批量打标时的快捷候选 */
export const GENERAL_TAG_PRESETS: string[] = [
  '计划内',
  '计划外',
  '复盘重点',
  '值得复制',
  '过度交易',
  '仓位过大',
  '持仓过久',
  '手感单',
];
