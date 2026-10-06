// 动画选段导出：把 [first, last]（动画帧编号 1 起的闭区间）烘焙为自包含 APNG。
//
// 做法：用合成器预计算的“展示后”快照，把选段每一帧重编码为全画布、
// blend=SOURCE、dispose=NONE 的帧——显示像素与原动画对应帧逐字节一致，
// 且完全不依赖未导出的历史帧（透明覆盖、BACKGROUND/PREVIOUS 清理的残留
// 都已烘进像素）。各帧延迟与循环次数原样保留；默认图角色与源一致：
// 源有独立海报时海报原样保留、不计入动画编号；源默认图参与动画时，
// 输出 IDAT 为选段首帧的完整合成画布。
//
// 交付前自检：输出重新走一遍本页导入管线（解析→组装→解码→合成），逐帧核对
// 显示像素 / 延迟 / 循环次数 / 海报；非法范围、损坏源文件、超出既有文件约束
// 或自检不一致一律抛 PngError 拒绝，调用方不得据此触发下载。
import { parsePng, PngError, LIMITS } from "./png-chunks.js";
import { assembleApng } from "./apng.js";
import { decodePngPixels } from "./png-decode.js";
import { computeFrameStates, DISPOSE, BLEND } from "./compositor.js";
import { deflate } from "./png-encode.js";
import { crc32 } from "./crc32.js";

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function chunk(type, payload) {
  const out = new Uint8Array(payload.length + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  view.setUint32(
    payload.length + 8,
    crc32(out.subarray(4, payload.length + 8)),
  );
  return out;
}

function join(parts) {
  const out = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

function u32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

// 烘焙帧的 fcTL：全画布矩形、SOURCE/NONE、保留原帧延迟。
function bakedFctl(sequence, width, height, frame) {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  view.setUint32(0, sequence);
  view.setUint32(4, width);
  view.setUint32(8, height);
  // x=12 / y=16 保持 0：覆盖整个画布
  view.setUint16(20, frame.delayNum);
  view.setUint16(22, frame.delayDen);
  out[24] = DISPOSE.NONE;
  out[25] = BLEND.SOURCE;
  return chunk("fcTL", out);
}

// RGBA 画布 → 待压缩原始数据（每行前置滤波类型 0），与 png-encode 一致。
function rawFromRgba(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return raw;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 完整走一遍导入管线：损坏源文件在此抛出 PngError（拒绝导出）。
async function loadAnimation(bytes) {
  const parsed = parsePng(bytes);
  const anim = assembleApng(parsed);
  if (!anim.isAnimated) {
    throw new PngError("该文件不是 APNG 动画（无 acTL），没有可导出的动画选段");
  }
  for (const f of anim.frames) {
    f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
  }
  const states = computeFrameStates(
    anim.frames,
    parsed.ihdr.width,
    parsed.ihdr.height,
  );
  return { parsed, anim, states };
}

// 自检：把导出结果当作新文件重新导入，逐帧核对显示像素、延迟、循环次数与海报。
async function verifyReimport(out, source, first, baked) {
  const { anim, states, width, height } = source;
  const parsed = parsePng(out);
  const check = assembleApng(parsed);
  if (!check.isAnimated || check.frames.length !== baked.length) {
    throw new PngError("导出结果自检失败：重新导入后帧数与选段不符");
  }
  if (check.numPlays !== anim.numPlays) {
    throw new PngError("导出结果自检失败：循环次数与原动画不一致");
  }
  if (check.defaultInAnimation !== anim.defaultInAnimation) {
    throw new PngError("导出结果自检失败：默认图角色与源文件不一致");
  }
  for (const f of check.frames) {
    f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
  }
  const checkStates = computeFrameStates(check.frames, width, height);
  for (let k = 0; k < baked.length; k++) {
    if (!equalBytes(checkStates[k].display, states[first - 1 + k].display)) {
      throw new PngError(
        `导出结果自检失败：第 ${first + k} 帧显示像素与原动画不一致`,
      );
    }
    const cf = check.frames[k];
    if (
      cf.delayNum !== baked[k].delayNum ||
      cf.delayDen !== baked[k].delayDen
    ) {
      throw new PngError(`导出结果自检失败：第 ${first + k} 帧延迟被改变`);
    }
  }
  if (!anim.defaultInAnimation) {
    const before = await decodePngPixels(
      anim.defaultImageCompressed,
      width,
      height,
    );
    const after = await decodePngPixels(
      check.defaultImageCompressed,
      width,
      height,
    );
    if (!equalBytes(before, after)) {
      throw new PngError("导出结果自检失败：静态海报与原文件不一致");
    }
  }
}

// 导出 [first, last]（1 起闭区间，单帧 first===last 合法）为独立 APNG 字节。
// 纯函数：只读输入字节，不修改源文件、不触碰调用方的会话状态。
export async function exportRange(bytes, first, last) {
  const { parsed, anim, states } = await loadAnimation(bytes);
  const { width, height } = parsed.ihdr;
  const total = anim.frames.length;

  if (!Number.isInteger(first) || !Number.isInteger(last)) {
    throw new PngError(`选段帧编号必须是整数，收到 ${first}、${last}`);
  }
  if (first < 1 || last > total || first > last) {
    throw new PngError(
      `非法选段 ${first}–${last}：动画共 ${total} 帧，` +
        `有效范围为 1–${total} 的闭区间`,
    );
  }

  // 烘焙：选段每帧重编码为原动画该帧的完整显示画布。
  const baked = [];
  for (let k = 0; k < last - first + 1; k++) {
    const frame = anim.frames[first - 1 + k];
    baked.push({
      compressed: await deflate(
        rawFromRgba(states[first - 1 + k].display, width, height),
      ),
      delayNum: frame.delayNum,
      delayDen: frame.delayDen,
    });
  }

  const parts = [
    PNG_SIGNATURE,
    chunk("IHDR", parsed.chunks[0].data),
    chunk("acTL", join([u32(baked.length), u32(anim.numPlays)])),
  ];
  let sequence = 0; // fcTL/fdAT 共享序号，从 0 连续递增
  if (anim.defaultInAnimation) {
    // 源默认图即第一帧：输出保持同样结构，IDAT = 选段首帧的完整合成画布。
    parts.push(bakedFctl(sequence++, width, height, baked[0]));
    parts.push(chunk("IDAT", baked[0].compressed));
    for (let k = 1; k < baked.length; k++) {
      parts.push(bakedFctl(sequence++, width, height, baked[k]));
      parts.push(chunk("fdAT", join([u32(sequence++), baked[k].compressed])));
    }
  } else {
    // 源有独立静态海报：压缩数据原样保留（不计入动画编号），动画帧全走 fdAT。
    parts.push(chunk("IDAT", anim.defaultImageCompressed));
    for (const b of baked) {
      parts.push(bakedFctl(sequence++, width, height, b));
      parts.push(chunk("fdAT", join([u32(sequence++), b.compressed])));
    }
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  const out = join(parts);

  // 输出必须满足与本页载入一致的文件约束（帧数 ≤ 16、画布 ≤ 64×64 天然成立）。
  if (out.length > LIMITS.MAX_FILE_BYTES) {
    throw new PngError(
      `导出结果 ${out.length} 字节，超过 64 KiB 文件上限，拒绝导出`,
    );
  }

  await verifyReimport(out, { anim, states, width, height }, first, baked);
  return out;
}
