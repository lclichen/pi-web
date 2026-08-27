#!/usr/bin/env node
/**
 * gen-icon.mjs — 生成分发包的应用图标（纯 Node 实现，无外部依赖）。
 *
 * 输出 PNG 到 stdout 或指定路径；在打包脚本里调用：
 *   node packaging/gen-icon.mjs <size> <output.png>
 *
 * 图案：深蓝圆角方块 + 白色学士帽（平台的教学属性），像素级合成后
 * 用 zlib 压缩写成合法 PNG（无色彩配置块，兼容各桌面环境）。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = Number(process.argv[2] ?? 256);
const OUT = process.argv[3] ?? null;

const px = new Uint8Array(SIZE * SIZE * 4); // RGBA

const clamp01 = (v) => Math.min(1, Math.max(0, v));
function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE || a <= 0) return;
  const i = (y * SIZE + x) * 4;
  const na = clamp01(a);
  px[i] = Math.round(px[i] * (1 - na) + r * na);
  px[i + 1] = Math.round(px[i + 1] * (1 - na) + g * na);
  px[i + 2] = Math.round(px[i + 2] * (1 - na) + b * na);
  px[i + 3] = Math.round(Math.max(px[i + 3], na * 255));
}

/** 抗锯齿填充圆角矩形 */
function roundRect(x0, y0, x1, y1, radius, color) {
  const [r, g, b] = color;
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
      // 每像素用中心点计算到圆角矩形的有符号距离
      const cx = Math.min(Math.max(x + 0.5, x0 + radius), x1 - radius);
      const cy = Math.min(Math.max(y + 0.5, y0 + radius), y1 - radius);
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      const alpha = clamp01(radius - dist + 0.5);
      if (alpha > 0 && x + 0.5 >= x0 && x + 0.5 <= x1 && y + 0.5 >= y0 && y + 0.5 <= y1) {
        blend(x, y, r, g, b, alpha);
      }
    }
  }
}

/** 实心三角形（重心坐标抗锯齿近似：超采样） */
function triangle(p0, p1, p2, color) {
  const [r, g, b] = color;
  const minX = Math.floor(Math.min(p0[0], p1[0], p2[0]));
  const maxX = Math.ceil(Math.max(p0[0], p1[0], p2[0]));
  const minY = Math.floor(Math.min(p0[1], p1[1], p2[1]));
  const maxY = Math.ceil(Math.max(p0[1], p1[1], p2[1]));
  const sign = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let hit = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const sx = x + ox, sy = y + oy;
        const d1 = sign(sx, sy, p0[0], p0[1], p1[0], p1[1]);
        const d2 = sign(sx, sy, p1[0], p1[1], p2[0], p2[1]);
        const d3 = sign(sx, sy, p2[0], p2[1], p0[0], p0[1]);
        const neg = d1 < 0 || d2 < 0 || d3 < 0;
        const pos = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(neg && pos)) hit++;
      }
      if (hit > 0) blend(x, y, r, g, b, hit / 4);
    }
  }
}

// ---- 构图 ----
const BLUE = [37, 99, 235];     // var(--accent) 同色系
const WHITE = [255, 255, 255];

roundRect(0, 0, SIZE - 1, SIZE - 1, SIZE * 0.18, BLUE);

// 学士帽：菱形帽面 + 底座横条 + 流苏
{
  const c = SIZE / 2;
  const hatW = SIZE * 0.34, hatY = SIZE * 0.30;
  triangle([c, hatY], [c - hatW, hatY + SIZE * 0.16], [c, hatY + SIZE * 0.32], WHITE);
  triangle([c, hatY], [c + hatW, hatY + SIZE * 0.16], [c, hatY + SIZE * 0.32], WHITE);
  // 帽身（梯形近似的第二层菱形下沿）
  triangle([c, hatY + SIZE * 0.10], [c - SIZE * 0.17, hatY + SIZE * 0.24], [c, hatY + SIZE * 0.36], WHITE);
  triangle([c, hatY + SIZE * 0.10], [c + SIZE * 0.17, hatY + SIZE * 0.24], [c, hatY + SIZE * 0.36], WHITE);
}

// ---- 编码 PNG ----
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA

// 每行前置 filter byte 0
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

if (OUT) writeFileSync(OUT, png);
else process.stdout.write(png);
console.error(`icon ${SIZE}x${SIZE} -> ${OUT ?? "<stdout>"} (${png.length} bytes)`);
