/**
 * 生成安装包用的应用图标（纯 Node 实现，不依赖图形库）：
 *   1. 以 3x3 超采样绘制圆角方块 + 蓝紫渐变 + 白色五角星；
 *   2. 编码为 PNG（zlib 压缩）；
 *   3. 打包成多尺寸 ICO（16/24/32/48/64/128/256，PNG 压缩格式）。
 * 用法：node scripts/make-icon.js  →  输出 build/icon.ico 与 build/icon.png
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');
const buildDir = path.join(root, 'build');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

/* ---------------- PNG 编码 ---------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 图形绘制 ---------------- */

// 圆角方块：判断点是否在圆角矩形内
function insideRoundRect(x, y, size, radius) {
  const min = 0;
  const max = size;
  const r = radius;
  const inX = x >= min && x <= max;
  const inY = y >= min && y <= max;
  if (!inX || !inY) return false;
  const cx = Math.min(Math.max(x, min + r), max - r);
  const cy = Math.min(Math.max(y, min + r), max - r);
  if (x >= min + r && x <= max - r) return true;
  if (y >= min + r && y <= max - r) return true;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// 五角星：点是否在多边形内（射线法）
function starPolygon(size) {
  const cx = size / 2;
  const cy = size * 0.53;
  const outer = size * 0.345;
  const inner = size * 0.138;
  const points = [];
  for (let i = 0; i < 10; i += 1) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? outer : inner;
    points.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]);
  }
  return points;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const star = starPolygon(size);
  const samples = 3; // 3x3 超采样抗锯齿
  const step = 1 / samples;
  // 渐变：左上 #6f9bff → 右下 #b083ff
  const from = [111, 155, 255];
  const to = [176, 131, 255];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let coverBox = 0;
      let coverStar = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) * step;
          const py = y + (sy + 0.5) * step;
          if (insideRoundRect(px, py, size, radius)) coverBox += 1;
          if (insidePolygon(px, py, star)) coverStar += 1;
        }
      }
      const total = samples * samples;
      const alpha = coverBox / total;
      if (alpha <= 0) continue;
      const t = (x + y) / (2 * (size - 1));
      const starRatio = coverStar / total; // 星形在方块内的占比
      const r = Math.round(lerp(lerp(from[0], to[0], t), 255, starRatio));
      const g = Math.round(lerp(lerp(from[1], to[1], t), 255, starRatio));
      const b = Math.round(lerp(lerp(from[2], to[2], t), 255, starRatio));
      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

/* ---------------- ICO 打包 ---------------- */

function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  const datas = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const entry = Buffer.alloc(16);
    entry[0] = img.size >= 256 ? 0 : img.size;
    entry[1] = img.size >= 256 ? 0 : img.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(img.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    datas.push(img.data);
    offset += img.data.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

fs.mkdirSync(buildDir, { recursive: true });
const images = SIZES.map((size) => ({ size, data: encodePng(size, size, renderIcon(size)) }));
const ico = packIco(images);
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(buildDir, 'icon.png'), images[images.length - 1].data);
console.log(`[icon] 已生成 build/icon.ico（${SIZES.join('/')} 共 ${ico.length} 字节）与 build/icon.png`);
