/**
 * 一键打 Windows 安装包：
 *   1. 生成应用图标（build/icon.ico）
 *   2. 生成随包说明（build/使用说明.txt）
 *   3. 调用 electron-builder 产出 NSIS 安装包到 dist-installer/
 * 用法：npm run dist:installer
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');
const outDir = path.join(root, 'dist-installer');
const guideText = require('./guide-text');

function fail(message) {
  console.error(`[dist] ${message}`);
  process.exit(1);
}

for (const file of ['renderer/vendor/marked.umd.js', 'renderer/vendor/purify.min.js']) {
  if (!fs.existsSync(path.join(root, file))) fail(`缺少 ${file}，请先执行 node scripts/prepare-vendor.js`);
}

// 运行中的 StarHub 会锁住 dist-installer 里的文件，重新打包前先提示关闭
if (process.platform === 'win32' && fs.existsSync(outDir)) {
  try {
    const tasks = require('child_process').execSync('tasklist /FI "IMAGENAME eq StarHub.exe" /NH', {
      encoding: 'utf8',
    });
    if (tasks.includes('StarHub.exe')) {
      fail('检测到 StarHub.exe 正在运行：请先关闭已打开的 StarHub 再重新打包');
    }
  } catch (_) {
    /* tasklist 不可用时忽略 */
  }
}

// 1) 图标
const iconScript = path.join(__dirname, 'make-icon.js');
const icon = spawnSync(process.execPath, [iconScript], { cwd: root, stdio: 'inherit' });
if (icon.status !== 0) fail('图标生成失败');

// 2) 使用说明（与便携版共用同一份文案）
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, '使用说明.txt'), `\ufeff${guideText()}`, 'utf8');
console.log('[dist] 已生成 build/使用说明.txt');

// 3) electron-builder
const cli = path.join(root, 'node_modules', 'electron-builder', 'cli.js');
if (!fs.existsSync(cli)) fail('未找到 electron-builder，请先执行 npm install');

const env = {
  ...process.env,
  // 国内网络优先走镜像，若镜像不可用可删掉这两行（默认走 GitHub）
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
    'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

console.log('[dist] 开始打包安装包（首次会下载 NSIS 等工具，可能需要几分钟）…');
const build = spawnSync(process.execPath, [cli, '--win', 'nsis', '--x64', '--publish', 'never'], {
  cwd: root,
  stdio: 'inherit',
  env,
});
if (build.status !== 0) fail(`electron-builder 退出码 ${build.status}`);

// 4) 汇报产物
const exe = fs
  .readdirSync(outDir)
  .filter((f) => f.toLowerCase().endsWith('.exe'))
  .map((f) => ({ name: f, size: fs.statSync(path.join(outDir, f)).size }))
  .sort((a, b) => b.size - a.size);
if (!exe.length) fail('打包完成但没有找到 .exe 产物');
for (const item of exe) {
  console.log(`[dist] 安装包: ${path.join(outDir, item.name)}（${(item.size / 1024 / 1024).toFixed(1)} MB）`);
}
console.log('[dist] 完成');
