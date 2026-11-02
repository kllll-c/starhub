/**
 * 把 marked / dompurify 的浏览器版构建复制到 renderer/vendor，
 * 这样渲染进程可以直接用 <script src> 加载，打包时也不依赖 node_modules 的目录结构。
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

const targets = [
  { pkg: 'marked', from: 'lib/marked.umd.js', to: 'marked.umd.js' },
  { pkg: 'dompurify', from: 'dist/purify.min.js', to: 'purify.min.js' },
];

for (const t of targets) {
  const src = path.join(root, 'node_modules', t.pkg, t.from);
  const dst = path.join(vendorDir, t.to);
  if (!fs.existsSync(src)) {
    console.warn(`[prepare-vendor] 未找到 ${src}，请先执行 npm install`);
    continue;
  }
  fs.copyFileSync(src, dst);
  console.log(`[prepare-vendor] ${t.to} <- ${t.pkg}/${t.from}`);
}
