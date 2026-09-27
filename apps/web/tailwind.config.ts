import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 主题 token：全部走 CSS 变量（RGB 通道形式），由 lib/appearance.ts 写入，
        // 因此 bg-up/15 这类透明度修饰符仍然可用。
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        // 盈亏配色（可在「设置 → 外观」自定义，默认红涨绿跌）
        up: 'rgb(var(--pnl-up) / <alpha-value>)',
        down: 'rgb(var(--pnl-down) / <alpha-value>)',
      },
    },
  },
  plugins: [],
};
export default config;
