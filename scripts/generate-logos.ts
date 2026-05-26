#!/usr/bin/env bun
/**
 * Zap logo 生成器
 *
 * 流程:
 *   1. 读取 assets/zap-logo.svg(品牌主图)
 *   2. 同步到 logo.svg / website/public/logo.svg / website/dist/logo.svg
 *   3. sharp 直接彩色栅格化为各尺寸透明 PNG, 统一加 ~10% safe-area padding
 *      (Apple HIG 要求 macOS dock icon 内容只占画布 ~80%; Linux/Windows
 *      共用同一份带 padding 的版本,视觉一致)
 *   4. 写入根目录 logo.png(512x512)
 *   5. 小尺寸 BMP + 大尺寸 PNG 合成 icon.ico, 与上游 warpdotdev/warp 格式对齐
 *   6. 写入 app/channels/<ch>/icon/padded/(本仓库目前只有 oss)
 *
 * 用法:  cd scripts && bun install && bun run logos
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCE_SVG = path.join(REPO_ROOT, "assets", "zap-logo.svg");
const ROOT_LOGO_PNG = path.join(REPO_ROOT, "logo.png");

const SVG_MIRRORS = [
  path.join(REPO_ROOT, "logo.svg"),
  path.join(REPO_ROOT, "website", "public", "logo.svg"),
  path.join(REPO_ROOT, "website", "dist", "logo.svg"),
];

// macOS DockTilePlugin 的 "Default" 皮肤(用户在设置里切换 dock 图标主题用),
// 必须跟 app icon 默认形象保持一致;其他 20+ 装饰皮肤(aurora/neon/cow 等)不动。
const DOCKTILE_DEFAULT_PNG = path.join(
  REPO_ROOT,
  "app",
  "DockTilePlugin",
  "Resources",
  "warp_2.png",
);

// 本仓库目前只有 oss 一个 channel(app/channels/oss/)。
// 如果将来新增 channel,只需在这里追加;脚本会跳过不存在的目录。
const CANDIDATE_CHANNELS = ["oss"] as const;
const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512] as const;
// 与上游 warpdotdev/warp 对齐: 16/32/48/64 用 BMP, 256 用 PNG 嵌入。
// 这样总大小 ~110KB, Windows 任务栏不会先解码大尺寸 BMP 而显示透明占位。
const ICO_BMP_SIZES = [16, 32, 48, 64] as const;
const ICO_PNG_SIZES = [256] as const;
// macOS dock 不会再额外加 padding, 必须靠图本身留 safe area。
// Apple HIG 经典值是 ~10%; Linux/Windows 跟着用同一份也不会有副作用。
const PADDING_RATIO = 0.1;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function renderPng(svg: Buffer, size: number): Promise<Buffer> {
  const padding = Math.round(size * PADDING_RATIO);
  const inner = Math.max(1, size - padding * 2);
  const innerPng = await sharp(svg, { density: 768 })
    .resize(inner, inner, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: innerPng, gravity: "center" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** 把 PNG buffer 解码成 RGBA raw, 用于 ICO 中的 BMP DIB 编码 */
async function decodeRgba(png: Buffer): Promise<{ width: number; height: number; data: Buffer }> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** ICO 中 BMP image 的编码: BITMAPINFOHEADER (height 双倍) + XOR map (BGRA, 自下而上) + AND map */
function encodeBmpDib(rgba: { width: number; height: number; data: Buffer }): Buffer {
  const { width, height, data } = rgba;
  if (width !== height) throw new Error(`ICO 要求方形, 实际 ${width}x${height}`);
  const bpp = 32;
  const xorSize = width * height * 4;
  const andRowStride = Math.ceil(width / 32) * 4; // 每行 32-bit 对齐
  const andSize = andRowStride * height;
  const headerSize = 40;
  const buf = Buffer.alloc(headerSize + xorSize + andSize);

  buf.writeUInt32LE(40, 0);
  buf.writeInt32LE(width, 4);
  buf.writeInt32LE(height * 2, 8); // ICO 约定 height 双倍 (XOR + AND 合计)
  buf.writeUInt16LE(1, 12);
  buf.writeUInt16LE(bpp, 14);
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(0, 20);

  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 4;
    const dstRow = headerSize + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x++) {
      const r = data[srcRow + x * 4];
      const g = data[srcRow + x * 4 + 1];
      const b = data[srcRow + x * 4 + 2];
      const a = data[srcRow + x * 4 + 3];
      buf[dstRow + x * 4] = b;
      buf[dstRow + x * 4 + 1] = g;
      buf[dstRow + x * 4 + 2] = r;
      buf[dstRow + x * 4 + 3] = a;
    }
  }

  const andOffset = headerSize + xorSize;
  for (let y = 0; y < height; y++) {
    const srcRow = y * width * 4;
    const dstRow = andOffset + (height - 1 - y) * andRowStride;
    for (let x = 0; x < width; x++) {
      const a = data[srcRow + x * 4 + 3];
      if (a === 0) {
        const byteIdx = dstRow + (x >> 3);
        const bitIdx = 7 - (x & 7);
        buf[byteIdx] |= 1 << bitIdx;
      }
    }
  }

  return buf;
}

/**
 * 自实现的 ICO 编码器 (取代 png-to-ico), 与上游 warpdotdev/warp 的格式对齐:
 * 小尺寸 (16/32/48/64) 用 BMP/DIB; 大尺寸 (256) 直接嵌入 PNG 字节, Windows
 * 通过 magic bytes (89 50 4E 47) 识别。ICO 文件总大小 ~110KB。
 */
async function buildIco(
  pngBySize: Map<number, Buffer>,
  bmpSizes: readonly number[],
  pngSizes: readonly number[],
): Promise<Buffer> {
  type Image = { size: number; data: Buffer };
  const images: Image[] = [];
  for (const size of bmpSizes) {
    const rgba = await decodeRgba(pngBySize.get(size)!);
    images.push({ size, data: encodeBmpDib(rgba) });
  }
  for (const size of pngSizes) {
    images.push({ size, data: pngBySize.get(size)! });
  }

  const headerSize = 6;
  const dirSize = 16 * images.length;
  let dataOffset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type=ICO
  header.writeUInt16LE(images.length, 4);

  const dirs: Buffer[] = [];
  for (const img of images) {
    const dir = Buffer.alloc(16);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // 256 写 0
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    dir.writeUInt8(0, 2);
    dir.writeUInt8(0, 3);
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(img.data.length, 8);
    dir.writeUInt32LE(dataOffset, 12);
    dirs.push(dir);
    dataOffset += img.data.length;
  }

  return Buffer.concat([header, ...dirs, ...images.map((i) => i.data)]);
}

async function main() {
  console.log(`[1/5] 读取源 SVG ${path.relative(REPO_ROOT, SOURCE_SVG)}`);
  const svgText = await fs.readFile(SOURCE_SVG, "utf8");
  const svgBuf = Buffer.from(svgText, "utf8");

  console.log(`[2/5] 同步 SVG 副本 (${SVG_MIRRORS.length} 份)`);
  for (const dst of SVG_MIRRORS) {
    if (!(await exists(path.dirname(dst)))) {
      console.log(`      ↷ 跳过 ${path.relative(REPO_ROOT, dst)} (父目录不存在)`);
      continue;
    }
    await fs.writeFile(dst, svgText, "utf8");
    console.log(`      ✓ ${path.relative(REPO_ROOT, dst)}`);
  }

  console.log(
    `[3/5] 彩色栅格化 PNG (${PNG_SIZES.join("/")}), 各尺寸保留 ${(PADDING_RATIO * 100).toFixed(0)}% safe-area`,
  );
  const pngBySize = new Map<number, Buffer>();
  for (const size of PNG_SIZES) {
    pngBySize.set(size, await renderPng(svgBuf, size));
  }
  await fs.writeFile(ROOT_LOGO_PNG, pngBySize.get(512)!);
  console.log(`      ✓ ${path.relative(REPO_ROOT, ROOT_LOGO_PNG)}`);
  if (await exists(path.dirname(DOCKTILE_DEFAULT_PNG))) {
    await fs.writeFile(DOCKTILE_DEFAULT_PNG, pngBySize.get(512)!);
    console.log(`      ✓ ${path.relative(REPO_ROOT, DOCKTILE_DEFAULT_PNG)}`);
  }

  console.log(
    `[4/5] 合成 icon.ico (${ICO_BMP_SIZES.join("/")} BMP + ${ICO_PNG_SIZES.join("/")} PNG)`,
  );
  const icoBuf = await buildIco(pngBySize, ICO_BMP_SIZES, ICO_PNG_SIZES);

  console.log(`[5/5] 写入实际存在的 channel`);
  let written = 0;
  for (const ch of CANDIDATE_CHANNELS) {
    const channelDir = path.join(REPO_ROOT, "app", "channels", ch);
    if (!(await exists(channelDir))) continue;
    const outDir = path.join(channelDir, "icon", "padded");
    await fs.mkdir(outDir, { recursive: true });
    for (const size of PNG_SIZES) {
      await fs.writeFile(path.join(outDir, `${size}x${size}.png`), pngBySize.get(size)!);
    }
    await fs.writeFile(path.join(outDir, "icon.ico"), icoBuf);
    console.log(`      ✓ ${ch}`);
    written += 1;
  }
  if (written === 0) {
    throw new Error("未找到任何 app/channels/<ch>/ 目录");
  }

  console.log("✅ 完成");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
