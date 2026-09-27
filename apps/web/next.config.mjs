import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 便携包构建开关（都不设时行为与原来完全一致，不影响 next dev）：
 *   NEXT_DIST_DIR     —— 输出目录覆盖，便于在 dev server 运行期间做一次隔离构建
 *   NEXT_STANDALONE   —— 生成自包含产物（含被追踪的 node_modules），供便携包离线运行
 */
const distDir = process.env.NEXT_DIST_DIR || '.next';
const standalone = process.env.NEXT_STANDALONE === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@trademind/trading-core'],
  reactStrictMode: true,
  distDir,
  ...(standalone
    ? {
        output: 'standalone',
        // monorepo：把仓库根作为追踪起点，才能把 workspace 包一并带进产物
        // 注意：Next 14 需放在 experimental 下（Next 15 才提升为顶层 key）
        experimental: {
          outputFileTracingRoot: path.join(__dirname, '../../'),
        },
      }
    : {}),
};

export default nextConfig;
