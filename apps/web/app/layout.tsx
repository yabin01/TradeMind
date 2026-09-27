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

/**
 * 便携包启动器会自动避让被占用的端口，真实 API 端口只有**运行时**才知道。
 * NEXT_PUBLIC_* 会被 Next 在构建期内联成常量，所以这里必须读服务端运行时环境变量，
 * 并强制按请求渲染，才能把当次运行的真实端口注入首屏。
 */
export const dynamic = 'force-dynamic';

const apiPort = process.env.TRADEMIND_API_PORT?.trim() || '4000';
const API_PORT_BOOTSTRAP_SCRIPT = `window.__TM_API_PORT__=${JSON.stringify(apiPort)};`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh" className="dark" data-theme="dark" suppressHydrationWarning>
      <head>
        {/* 首屏防闪烁：在样式生效前把主题与盈亏配色写到 <html> 上 */}
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SCRIPT }} />
        {/* 告诉前端 API 实际监听在哪个端口（必须在业务 bundle 之前执行） */}
        <script dangerouslySetInnerHTML={{ __html: API_PORT_BOOTSTRAP_SCRIPT }} />
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
