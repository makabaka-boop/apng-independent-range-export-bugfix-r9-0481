// 动画选段导出：按动画帧编号（0 起闭区间 [first, last]）把连续几帧导出为
// 可独立重新导入的 APNG。默认静态海报（不属于动画）不计入动画序号。
//
// 关键做法：选段中每一帧都用原动画该帧「展示后」的完整画布快照重新烘焙成
// 覆盖整个画布的帧——
//   · 第一张输出帧走 IDAT：它既是动画第一帧，也是独立的默认海报，
//     收件人从第一帧开始就看到原片段的完整画面，海报里不混入动画编号；
//   · 之后每帧也都是全画布 SOURCE 帧、dispose=NONE，因此既不需要
//     未导出的历史画布（透明 OVER、BACKGROUND/PREVIOUS 清理在烘焙时已生效），
//     也不依赖播放顺序：前进 / 后退 / 跳帧重新合成结果完全一致；
//   · 延迟（delayNum/delayDen）与循环次数（numPlays）原样保留。
// 返回前用同一套解析/校验管线重新导入自校验，超出 64 KiB 等既有约束即拒绝，
// 绝不返回一个看似成功、实际无法复核的文件。
import { parsePng, PngError, LIMITS } from "./png-chunks.js";
import { assembleApng } from "./apng.js";
import { decodePngPixels } from "./png-decode.js";
import { computeFrameStates } from "./compositor.js";
import { deflate, rawWithFilter0 } from "./png-encode.js";
import { crc32 } from "./crc32.js";

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
function word(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}
// 全画布帧的 fcTL：序号从 0 连续递增，矩形 (0,0) W×H，
// blend=SOURCE、dispose=NONE（展示后不清理，帧之间不再相互依赖）。
function fullCanvasControl(sequence, frame, width, height) {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  view.setUint32(0, sequence);
  view.setUint32(4, width);
  view.setUint32(8, height);
  view.setUint32(12, 0);
  view.setUint32(16, 0);
  view.setUint16(20, frame.delayNum);
  view.setUint16(22, frame.delayDen);
  out[24] = 0; // dispose_op = NONE
  out[25] = 0; // blend_op = SOURCE
  return chunk("fcTL", out);
}

// bytes：原 APNG 字节（只读，绝不修改）；first/last：0 起动画帧编号，闭区间。
// 返回导出 APNG 的字节。任何非法输入 / 损坏源 / 超限输出都抛出 PngError。
export async function exportRange(bytes, first, last) {
  // ---- 范围参数校验（在触碰源数据之前，避免损坏源时报错被掩盖）----
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))
    throw new PngError("选段起止帧必须是整数");
  if (first < 0 || last < 0) throw new PngError("帧编号从 1 开始，不允许负数");
  if (first > last)
    throw new PngError(
      `起始帧 ${first + 1} 不能晚于结束帧 ${last + 1}（区间为空）`,
    );

  // ---- 源文件重新走完整解析管线：坏文件直接拒绝，绝不回退静默导出 ----
  const parsed = parsePng(bytes);
  const anim = assembleApng(parsed);
  if (!anim.isAnimated) {
    throw new PngError("源文件不是动画（无 acTL），没有动画帧可以导出");
  }
  const count = anim.frames.length;
  if (first >= count || last >= count) {
    throw new PngError(
      `选段超出帧数：源动画共 ${count} 帧，收到 ${first + 1}–${last + 1}`,
    );
  }

  const width = parsed.ihdr.width;
  const height = parsed.ihdr.height;

  // ---- 解码并一次性预计算全部帧状态（与检查页同一条合成管线）----
  for (const f of anim.frames) {
    f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
  }
  const states = computeFrameStates(anim.frames, width, height);

  // ---- 把选段每帧烘焙成全画布 SOURCE 帧，延迟沿用原帧 ----
  const picked = anim.frames.slice(first, last + 1);
  const parts = [
    bytes.slice(0, 8), // PNG 签名
    chunk("IHDR", parsed.chunks.find((c) => c.type === "IHDR").data),
    chunk("acTL", join([word(picked.length), word(anim.numPlays)])),
  ];
  let sequence = 0; // 输出文件序号从 0 重新开始连续编号
  for (let i = 0; i < picked.length; i++) {
    const frame = picked[i];
    const display = states[first + i].display; // 原动画该帧的完整展示画布
    const compressed = await deflate(rawWithFilter0(width, height, display));
    if (i === 0) {
      // 第一帧的 fcTL 必须在 IDAT 之前：该 IDAT 既是动画第一帧、
      // 也是独立默认海报（同一数据，海报不另立编号）。
      parts.push(fullCanvasControl(sequence++, frame, width, height));
      parts.push(chunk("IDAT", compressed));
    } else {
      parts.push(fullCanvasControl(sequence++, frame, width, height));
      parts.push(chunk("fdAT", join([word(sequence++), compressed])));
    }
  }
  parts.push(chunk("IEND", new Uint8Array(0)));
  const output = join(parts);

  // ---- 超限输出拒绝（绝不触发一个成功的下载假象）----
  if (output.length > LIMITS.MAX_FILE_BYTES) {
    throw new PngError(
      `导出文件 ${output.length} 字节，超过 ${LIMITS.MAX_FILE_BYTES} 字节（64 KiB）上限，已拒绝导出`,
    );
  }

  // ---- 自校验：导出文件必须能被同一检查器重新导入并满足结构约束 ----
  const reparsed = parsePng(output);
  const reanim = assembleApng(reparsed);
  if (!reanim.isAnimated || reanim.frames.length !== picked.length) {
    throw new PngError("导出结果自校验失败：帧数与选段不符");
  }
  if (!reanim.defaultInAnimation) {
    throw new PngError("导出结果自校验失败：第一张帧必须即默认海报");
  }
  const firstFrame = reanim.frames[0];
  if (
    firstFrame.x !== 0 ||
    firstFrame.y !== 0 ||
    firstFrame.width !== width ||
    firstFrame.height !== height
  ) {
    throw new PngError("导出结果自校验失败：第一帧未覆盖整个画布");
  }

  return output;
}
