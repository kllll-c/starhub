/**
 * 免依赖打包脚本：把 Electron 运行时 + 应用代码组装成绿色便携版目录。
 * 用法：npm run pack  →  产物在 dist/StarHub-win32-x64/StarHub.exe
 * 说明：渲染层用的是 renderer/vendor 里的 marked / DOMPurify（由 postinstall 复制），
 * 主进程只依赖 Electron 内置模块，因此无需打包 node_modules。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');
const outDir = path.join(distDir, 'StarHub-win32-x64');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

function fail(message) {
  console.error(`[pack] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(electronDist)) fail('未找到 node_modules/electron/dist，请先完成依赖安装');
for (const file of ['renderer/vendor/marked.umd.js', 'renderer/vendor/purify.min.js']) {
  if (!fs.existsSync(path.join(root, file))) fail(`缺少 ${file}，请先执行 node scripts/prepare-vendor.js`);
}

// 运行中的 StarHub.exe 会锁定 dist 里的 icudtl.dat / v8_context_snapshot.bin，
// 直接覆盖会失败甚至让复制进程崩溃，所以先提示关闭程序
if (process.platform === 'win32' && fs.existsSync(outDir)) {
  try {
    const tasks = require('child_process').execSync('tasklist /FI "IMAGENAME eq StarHub.exe" /NH', {
      encoding: 'utf8',
    });
    if (tasks.includes('StarHub.exe')) {
      fail('检测到 StarHub.exe 正在运行：请先关闭已打开的 StarHub 再重新打包（运行中的程序会锁定 dist 目录里的文件）');
    }
  } catch (_) {
    /* tasklist 不可用时忽略 */
  }
}

try {
  fs.rmSync(outDir, { recursive: true, force: true });
} catch (err) {
  fail(`无法覆盖 ${outDir}（${err.code || err.message}），请关闭正在运行的 StarHub 后重试`);
}
fs.mkdirSync(outDir, { recursive: true });

// 1. 复制 Electron 运行时
fs.cpSync(electronDist, outDir, { recursive: true });
console.log('[pack] 已复制 Electron 运行时');

// 2. 复制应用代码到 resources/app
const appDir = path.join(outDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const prodPkg = {
  name: pkg.name,
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  license: pkg.license,
  main: pkg.main,
};
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(prodPkg, null, 2));

for (const entry of ['src', 'renderer']) {
  fs.cpSync(path.join(root, entry), path.join(appDir, entry), { recursive: true });
}
// 打包产物中不需要 postinstall 脚本和源码脚本
fs.rmSync(path.join(appDir, 'scripts'), { recursive: true, force: true });
console.log('[pack] 已复制应用代码:', appDir);

// 3. 重命名可执行文件
const exeSrc = path.join(outDir, 'electron.exe');
const exeDst = path.join(outDir, `${pkg.productName || 'StarHub'}.exe`);
if (fs.existsSync(exeSrc)) {
  fs.rmSync(exeDst, { force: true });
  fs.renameSync(exeSrc, exeDst);
  console.log('[pack] 可执行文件:', exeDst);
} else {
  fail('未找到 electron.exe，运行时复制可能不完整');
}

// 4. 随包附一份上手说明（对方首次启动需要的配置步骤都在这里）
const guideText = require('./guide-text');
fs.writeFileSync(path.join(outDir, '使用说明.txt'), `\ufeff${guideText()}`, 'utf8');
console.log('[pack] 已生成使用说明.txt');

const size = fs
  .readdirSync(outDir)
  .filter((f) => fs.statSync(path.join(outDir, f)).isFile())
  .reduce((sum, f) => sum + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`[pack] 完成，输出目录 ${outDir}（运行时文件约 ${(size / 1024 / 1024).toFixed(0)} MB）`);
