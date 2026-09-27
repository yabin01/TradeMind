import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import { Sidebar } from '../components/sidebar';
import { FilterBar } from '../components/filter-bar';
import { APPEARANCE_BOOTSTRAP_SCRIPT } from '../lib/appearance';

export const metadata: Metadata = {
  title: 'TradeMind — AI Trading Journal & Analytics',
  description: '智能交易日志、交易分析、策略分析与 AI Trading Coach',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className="dark" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* 首屏防闪烁：在样式生效前把主题与盈亏配色写到 <html> 上 */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">
              <FilterBar />
              <main className="flex-1 overflow-y-auto p-6">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
