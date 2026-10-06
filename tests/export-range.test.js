// 选段导出测试：导出 → 重新走导入管线（解析/组装/解码/合成）→ 逐帧核对
// 显示像素、延迟、循环次数与海报；非法范围、坏文件、超限输出一律拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePng, PngError } from "../site/js/png-chunks.js";
import { assembleApng } from "../site/js/apng.js";
import { decodePngPixels } from "../site/js/png-decode.js";
import { computeFrameStates } from "../site/js/compositor.js";
import { exportRange } from "../site/js/export-range.js";
import { buildApng, solid, px } from "./helpers.js";

const RED = [255, 0, 0, 255];
const SEMI_BLUE = [0, 0, 255, 128];
const GREEN = [0, 255, 0, 255];
const WHITE = [255, 255, 255, 255];
const POSTER = [10, 20, 30, 255];

// 与本页载入一致的导入管线：任一校验失败都会抛出。
async function reimport(bytes) {
  const parsed = parsePng(bytes);
  const anim = assembleApng(parsed);
  for (const f of anim.frames)
    f.pixels = await decodePngPixels(f.compressed, f.width, f.height);
  const states = computeFrameStates(
    anim.frames,
    parsed.ihdr.width,
    parsed.ihdr.height,
  );
  return { parsed, anim, states };
}

// 含透明覆盖、BACKGROUND/PREVIOUS 清理与独立海报的 4 帧动画（8×8）。
function buildTrickySource(numPlays = 3) {
  return buildApng({
    width: 8,
    height: 8,
    numPlays,
    defaultImage: solid(8, 8, POSTER),
    frames: [
      {
        x: 0, y: 0, width: 4, height: 4,
        rgba: solid(4, 4, RED),
        dispose: 0, blend: 0, delayNum: 1, delayDen: 10,
      },
      {
        x: 2, y: 2, width: 4, height: 4,
        rgba: solid(4, 4, SEMI_BLUE),
        dispose: 1, blend: 1, delayNum: 3, delayDen: 100,
      },
      {
        x: 0, y: 0, width: 2, height: 2,
        rgba: solid(2, 2, GREEN),
        dispose: 2, blend: 0, delayNum: 5, delayDen: 100,
      },
      {
        x: 6, y: 6, width: 2, height: 2,
        rgba: solid(2, 2, WHITE),
        dispose: 0, blend: 1, delayNum: 7, delayDen: 100,
      },
    ],
  });
}

test("中途起始选段：重新导入后每帧显示像素、延迟、循环次数与原动画一致", async () => {
  const source = buildTrickySource(3);
  const original = await reimport(source);

  const out = await exportRange(source, 2, 4);
  assert.ok(out.length <= 64 * 1024, "输出在 64 KiB 约束内");

  const re = await reimport(out);
  assert.equal(re.anim.isAnimated, true);
  assert.equal(re.anim.frames.length, 3, "选段 2–4 共 3 帧");
  assert.equal(re.anim.numPlays, 3, "循环次数保留");

  for (let k = 0; k < 3; k++) {
    assert.deepEqual(
      [...re.states[k].display],
      [...original.states[k + 1].display],
      `导出第 ${k + 1} 帧显示像素 == 原动画第 ${k + 2} 帧`,
    );
    assert.equal(re.anim.frames[k].delayNum, original.anim.frames[k + 1].delayNum);
    assert.equal(re.anim.frames[k].delayDen, original.anim.frames[k + 1].delayDen);
  }

  // 首帧不依赖未导出的历史：第 1 帧的残留与半透明叠加都已烘进像素
  assert.deepEqual(px(re.states[0].display, 8, 0, 0), RED, "未导出的第 1 帧残留已烘入");
  assert.deepEqual(
    px(re.states[0].display, 8, 2, 2),
    [127, 0, 128, 255],
    "半透明蓝叠红的历史合成结果已烘入",
  );

  // 烘焙帧均为全画布 SOURCE/NONE：任何前序画布状态下显示都确定
  for (const f of re.anim.frames) {
    assert.equal(f.width, 8);
    assert.equal(f.height, 8);
    assert.equal(f.x, 0);
    assert.equal(f.y, 0);
    assert.equal(f.blend, 0, "blend=SOURCE");
    assert.equal(f.dispose, 0, "dispose=NONE");
  }
});

test("独立海报：原样保留且不计入动画编号", async () => {
  const source = buildTrickySource(0);
  const out = await exportRange(source, 2, 3);
  const re = await reimport(out);

  assert.equal(re.anim.defaultInAnimation, false, "海报仍是海报");
  assert.equal(re.anim.frames.length, 2, "acTL 帧数不含海报");
  const poster = await decodePngPixels(re.anim.defaultImageCompressed, 8, 8);
  assert.deepEqual(px(poster, 8, 3, 3), POSTER, "海报像素与源一致");
  assert.deepEqual(px(poster, 8, 7, 7), POSTER);
});

test("默认图属于动画：输出 IDAT 为选段首帧的完整合成画布，序号从 0 连续", async () => {
  const source = buildApng({
    width: 8,
    height: 8,
    defaultInAnimation: true,
    defaultImage: solid(8, 8, [50, 60, 70, 255]),
    numPlays: 2,
    frames: [
      {
        width: 8, height: 8,
        rgba: solid(8, 8, [50, 60, 70, 255]),
        dispose: 0, blend: 0, delayNum: 1, delayDen: 10,
      },
      {
        x: 4, y: 4, width: 4, height: 4,
        rgba: solid(4, 4, [0, 255, 0, 128]),
        dispose: 2, blend: 1, delayNum: 2, delayDen: 10,
      },
      {
        x: 0, y: 0, width: 2, height: 2,
        rgba: solid(2, 2, [255, 255, 0, 255]),
        dispose: 1, blend: 0, delayNum: 0, delayDen: 0, // delay_den=0 按 100 处理
      },
    ],
  });
  const original = await reimport(source);

  const out = await exportRange(source, 2, 3);
  const re = await reimport(out);
  assert.equal(re.anim.defaultInAnimation, true, "默认图仍参与动画");
  assert.equal(re.anim.frames.length, 2);
  assert.equal(re.anim.frames[0].fromIdat, true, "首帧来自 IDAT");
  assert.equal(re.anim.numPlays, 2);

  // 输出默认图（IDAT）== 原动画第 2 帧的完整合成画布
  const idatPixels = await decodePngPixels(re.anim.frames[0].compressed, 8, 8);
  assert.deepEqual(
    [...idatPixels],
    [...original.states[1].display],
    "IDAT 显示原动画该帧的完整合成画布",
  );
  assert.deepEqual(
    [...re.states[1].display],
    [...original.states[2].display],
  );

  // 延迟保留：delay_den=0 的源帧按规范等效为 100
  assert.equal(re.anim.frames[2 - 1].delayNum, 0);
  assert.equal(re.anim.frames[2 - 1].delayDen, 100, "0 按 100 处理，有效延迟不变");

  // fcTL/fdAT 序号从 0 连续递增
  const seqs = re.parsed.chunks
    .filter((c) => c.type === "fcTL" || c.type === "fdAT")
    .map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
  assert.deepEqual(seqs, [0, 1, 2]);
});

test("合法单帧选段（first === last）可交付", async () => {
  const source = buildTrickySource(0);
  const original = await reimport(source);

  const out = await exportRange(source, 3, 3);
  const re = await reimport(out);
  assert.equal(re.anim.frames.length, 1);
  assert.deepEqual(
    [...re.states[0].display],
    [...original.states[2].display],
    "单帧导出显示原动画第 3 帧的完整画面",
  );
  assert.deepEqual(px(re.states[0].display, 8, 0, 0), GREEN);
});

test("导出文件任意跳转顺序访问结果一致", async () => {
  const source = buildTrickySource(0);
  const out = await exportRange(source, 1, 4);
  const first = await reimport(out);
  const again = await reimport(out);
  for (const i of [3, 0, 2, 1, 3, 2]) {
    assert.deepEqual(
      [...again.states[i].display],
      [...first.states[i].display],
      `第 ${i + 1} 帧显示与访问顺序无关`,
    );
  }
});

test("非法范围一律拒绝：越界、倒序、非整数", async () => {
  const source = buildTrickySource(0); // 共 4 帧
  for (const [first, last] of [
    [0, 2],
    [-1, 2],
    [2, 1],
    [1, 5],
    [5, 5],
    [1.5, 2],
    [NaN, 2],
    [2, NaN],
  ]) {
    await assert.rejects(
      exportRange(source, first, last),
      PngError,
      `选段 ${first}–${last} 应被拒绝`,
    );
  }
  await assert.rejects(exportRange(source, 0, 2), /非法选段/);
  await assert.rejects(exportRange(source, 1.5, 2), /整数/);
});

test("损坏源文件拒绝导出（CRC 破坏）", async () => {
  const source = buildTrickySource(0);
  const bad = source.slice();
  const idx = bad.findIndex(
    (v, i) =>
      v === 0x66 && bad[i + 1] === 0x64 && bad[i + 2] === 0x41 && bad[i + 3] === 0x54,
  );
  assert.ok(idx > 0, "找到 fdAT");
  bad[idx + 8] ^= 0xff;
  await assert.rejects(exportRange(bad, 1, 2), /CRC 校验失败/);
});

test("静态 PNG（无 acTL）没有可选段，拒绝导出", async () => {
  const { SIGNATURE, chunk, ihdr, idatFromRgba } = await import("./helpers.js");
  const staticPng = new Uint8Array([
    ...SIGNATURE,
    ...ihdr(4, 4),
    ...idatFromRgba(solid(4, 4, RED), 4, 4),
    ...chunk("IEND"),
  ]);
  await assert.rejects(exportRange(staticPng, 1, 1), /不是 APNG 动画/);
});

test("导出不改变原文件字节", async () => {
  const source = buildTrickySource(2);
  const snapshot = source.slice();
  await exportRange(source, 2, 4);
  assert.deepEqual([...source], [...snapshot], "输入字节未被修改");
});

// 确定性伪随机噪声（xorshift32），deflate 基本不可压缩。
function noise(w, h, seed) {
  let s = seed >>> 0 || 1;
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < out.length; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = s >>> 24;
  }
  return out;
}

test("超出 64 KiB 文件上限的输出拒绝导出；同源合法单帧仍可交付", async () => {
  // 16 帧各注入一块 16×16 噪声（SOURCE/NONE，4×4 网格铺满 64×64）：
  // 源文件约 17 KB，但全段导出需携带逐帧累积的显示画布（≈136 KB），必须拒绝。
  const frames = [];
  for (let i = 0; i < 16; i++) {
    frames.push({
      x: 16 * (i % 4),
      y: 16 * Math.floor(i / 4),
      width: 16,
      height: 16,
      rgba: noise(16, 16, 0x9e3779b9 + i),
      dispose: 0,
      blend: 0,
      delayNum: 1,
      delayDen: 10,
    });
  }
  const source = buildApng({ width: 64, height: 64, frames });
  assert.ok(source.length <= 64 * 1024, "源文件本身在约束内");

  await assert.rejects(exportRange(source, 1, 16), /超过 64 KiB 文件上限/);

  // 同一源文件的单帧选段（最后一帧，显示画布为全部噪声）仍在约束内，可交付
  const out = await exportRange(source, 16, 16);
  assert.ok(out.length <= 64 * 1024);
  const original = await reimport(source);
  const re = await reimport(out);
  assert.equal(re.anim.frames.length, 1);
  assert.deepEqual(
    [...re.states[0].display],
    [...original.states[15].display],
    "单帧交付的显示像素与原动画末帧一致",
  );
});
