// 动画选段导出测试：导出 → 落盘 → 重新导入本检查器同一套管线，核对
// 每帧完整显示像素、延迟、循环次数、独立海报、首帧不依赖历史、任意跳转一致；
// 并覆盖合法单帧、非法范围、静态源、损坏源、超限输出、源字节不变等拒绝路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PngError } from "../site/js/png-chunks.js";
import { parsePng } from "../site/js/png-chunks.js";
import { assembleApng } from "../site/js/apng.js";
import { decodePngPixels } from "../site/js/png-decode.js";
import { computeFrameStates, blendRect } from "../site/js/compositor.js";
import { exportRange } from "../site/js/export-range.js";
import {
  buildApng,
  solid,
  px,
  chunk,
  SIGNATURE,
  ihdr,
  idatFromRgba,
  concatBytes,
} from "./helpers.js";
import { buildSampleApng } from "../site/js/sample.js";

const RED = [255, 0, 0, 255];
const SEMI_BLUE = [0, 0, 255, 128];
const GREEN = [0, 255, 0, 255];
const WHITE = [255, 255, 255, 255];
const POSTER_GRAY = [10, 20, 30, 255];
const TRANSPARENT = [0, 0, 0, 0];

async function loadApng(bytes) {
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

// 落盘再读回，模拟收件人真实的重新导入路径。
async function reimportFromDisk(t, output) {
  const dir = mkdtempSync(join(tmpdir(), "apng-export-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "selection.png");
  writeFileSync(file, output);
  return loadApng(new Uint8Array(readFileSync(file)));
}

function delayMs(f) {
  return (f.delayNum / f.delayDen) * 1000;
}

// 含透明 OVER、BACKGROUND、PREVIOUS、局部矩形与历史残留的刁钻动画。
function trickySource({ numPlays = 0 } = {}) {
  return buildApng({
    width: 8,
    height: 8,
    numPlays,
    defaultImage: solid(8, 8, POSTER_GRAY),
    frames: [
      // 帧1：左上 4×4 不透明红 SOURCE，NONE 残留
      {
        x: 0, y: 0, width: 4, height: 4,
        rgba: solid(4, 4, RED), dispose: 0, blend: 0,
        delayNum: 3, delayDen: 100,
      },
      // 帧2：偏移 2,2 的 4×4 半透明蓝 OVER，BACKGROUND 只清自身矩形
      {
        x: 2, y: 2, width: 4, height: 4,
        rgba: solid(4, 4, SEMI_BLUE), dispose: 1, blend: 1,
        delayNum: 0, delayDen: 0, // den=0 按 100 处理（0ms）
      },
      // 帧3：2×2 绿 SOURCE，PREVIOUS 恢复本帧绘制前画布
      {
        x: 0, y: 0, width: 2, height: 2,
        rgba: solid(2, 2, GREEN), dispose: 2, blend: 0,
        delayNum: 7, delayDen: 10,
      },
      // 帧4：右下 2×2 白 OVER，NONE
      {
        x: 6, y: 6, width: 2, height: 2,
        rgba: solid(2, 2, WHITE), dispose: 0, blend: 1,
        delayNum: 5, delayDen: 10,
      },
    ],
  });
}

test("中途选段 [2,3] 重新导入：每帧完整像素、延迟、循环次数与原动画一致，且不依赖历史", async (t) => {
  const source = trickySource({ numPlays: 3 });
  const before = source.slice();
  const { anim, states } = await loadApng(source);

  const output = await exportRange(source, 1, 2); // 动画第 2–3 帧
  assert.ok(output.length <= 64 * 1024);
  // 源字节逐字节不变
  assert.equal(output.length > 0, true);
  assert.deepEqual([...source], [...before], "导出不修改输入文件字节");

  const re = await reimportFromDisk(t, output);
  assert.equal(re.anim.isAnimated, true);
  assert.equal(re.anim.frames.length, 2, "输出帧数等于选段帧数");
  assert.equal(re.anim.numPlays, 3, "循环次数保留");
  assert.equal(re.anim.defaultInAnimation, true, "第一张帧即独立默认海报");

  const f0 = re.anim.frames[0];
  assert.deepEqual(
    [f0.x, f0.y, f0.width, f0.height],
    [0, 0, 8, 8],
    "第一帧覆盖整个画布",
  );
  assert.equal(f0.fromIdat, true, "第一帧数据来自 IDAT（即默认海报）");
  assert.equal(f0.dispose, 0);
  assert.equal(f0.blend, 0);

  // 每帧展示像素 = 原动画对应帧的完整展示画布
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(
      [...re.states[i].display],
      [...states[1 + i].display],
      `输出第 ${i + 1} 帧与原动画第 ${2 + i} 帧像素一致`,
    );
  }

  // 原帧2只有 4×4 局部矩形，但选段第一帧必须带出矩形外的历史残留（红），
  // 这正是「直接切片原帧数据」做不到的。
  assert.deepEqual(px(re.states[0].display, 8, 0, 0), RED, "矩形外的历史残留被烘焙进完整画布");
  assert.deepEqual(px(re.states[0].display, 8, 2, 2), [127, 0, 128, 255]);
  assert.deepEqual(px(re.states[0].display, 8, 4, 4), SEMI_BLUE);
  // 第二帧：绿 + 未被 PREVIOUS/BACKGROUND 抹掉的红（烘焙时清理语义已结算）
  assert.deepEqual(px(re.states[1].display, 8, 0, 0), GREEN);
  assert.deepEqual(px(re.states[1].display, 8, 1, 1), GREEN, "2×2 绿块内部");
  assert.deepEqual(px(re.states[1].display, 8, 0, 2), RED, "绿块下方是未清理的红");

  // 海报不混入动画编号：默认图即第一帧（IDAT），解码就是第一帧完整画面，
  // 且不是源文件那张灰色默认海报
  assert.equal(re.anim.defaultImageCompressed, null, "没有游离于动画之外的独立海报数据");
  assert.deepEqual([...f0.pixels], [...states[1].display]);
  assert.notDeepEqual(px(f0.pixels, 8, 0, 0), POSTER_GRAY, "海报不是源静态回退图");

  // 首帧不依赖未导出的历史：从全透明画布单独绘制输出第一帧，结果相同
  const solo = new Uint8Array(8 * 8 * 4);
  blendRect(solo, 8, f0.pixels, 0, 0, 8, 8, f0.blend);
  assert.deepEqual([...solo], [...states[1].display]);

  // 延迟保留（含 den=0 归一化为 100）
  assert.equal(delayMs(re.anim.frames[0]), 0);
  assert.equal(re.anim.frames[0].delayDen, 100);
  assert.equal(delayMs(re.anim.frames[1]), delayMs(anim.frames[2]));

  // 任意跳转/乱序结果一致：每帧各自画到任意历史上都得到同一展示图
  for (const order of [
    [0, 1],
    [1, 0],
    [0, 1, 0, 1],
  ]) {
    let canvas = new Uint8Array(8 * 8 * 4);
    for (const k of order) {
      const f = re.anim.frames[k];
      blendRect(canvas, 8, f.pixels, 0, 0, 8, 8, f.blend);
      assert.deepEqual(
        [...canvas],
        [...re.states[k].display],
        `访问顺序 ${order.join(",")} 下第 ${k + 1} 帧像素一致`,
      );
    }
  }
});

test("内置示例（含局部矩形 + OVER/BACKGROUND/PREVIOUS）选段导出可复核", async (t) => {
  const source = await buildSampleApng();
  const { states } = await loadApng(source);
  // 从第 2 帧（受第 1 帧残留影响）开始选 3 帧
  const output = await exportRange(source, 1, 3);
  const re = await reimportFromDisk(t, output);
  assert.equal(re.anim.frames.length, 3);
  assert.equal(re.anim.defaultInAnimation, true);
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(
      [...re.states[i].display],
      [...states[1 + i].display],
      `示例选段输出第 ${i + 1} 帧像素与原预览一致`,
    );
  }
  // 所有输出帧都是 32×32 全画布 SOURCE/NONE，单帧即可独立成立
  for (const f of re.anim.frames) {
    assert.deepEqual([f.x, f.y, f.width, f.height], [0, 0, 32, 32]);
    assert.equal(f.dispose, 0);
    assert.equal(f.blend, 0);
  }
});

test("拒绝路径同样不改变源字节、不产生输出文件", async () => {
  const source = trickySource();
  const snapshot = source.slice();
  await assert.rejects(() => exportRange(source, 0, 99), PngError);
  assert.deepEqual([...source], [...snapshot]);
  // 重复尝试非法范围后，一个合法范围仍正常导出（状态无残留）
  const output = await exportRange(source, 0, 0);
  assert.ok(output.length > 0);
});

test("完整区间 [1,4]：四帧逐帧像素与原预览一致，无限循环（numPlays=0）保留", async (t) => {
  const source = trickySource();
  const { anim, states } = await loadApng(source);
  const output = await exportRange(source, 0, 3);
  const re = await reimportFromDisk(t, output);
  assert.equal(re.anim.frames.length, 4);
  assert.equal(re.anim.numPlays, 0);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual([...re.states[i].display], [...states[i].display]);
    assert.equal(delayMs(re.anim.frames[i]), delayMs(anim.frames[i]));
  }
  assert.deepEqual(px(re.states[3].display, 8, 7, 7), WHITE);
  assert.deepEqual(px(re.states[3].display, 8, 0, 0), RED);
});

test("合法单帧选段可交付：输出单帧 APNG，海报即该帧完整画面", async (t) => {
  const source = trickySource();
  const { states } = await loadApng(source);
  const output = await exportRange(source, 2, 2); // 只取第 3 帧
  const re = await reimportFromDisk(t, output);
  assert.equal(re.anim.frames.length, 1);
  assert.equal(re.anim.defaultInAnimation, true);
  assert.deepEqual([...re.states[0].display], [...states[2].display]);
  assert.deepEqual(px(re.states[0].display, 8, 0, 0), GREEN);
  assert.deepEqual(px(re.states[0].display, 8, 6, 6), TRANSPARENT, "原第 4 帧的白不应泄漏到单帧选段");
});

test("默认图即首帧的源：从中途导出，海报取所选帧而非源默认图", async (t) => {
  const source = buildApng({
    width: 8,
    height: 8,
    defaultInAnimation: true,
    defaultImage: solid(8, 8, [50, 60, 70, 255]),
    numPlays: 2,
    frames: [
      { width: 8, height: 8, rgba: solid(8, 8, [50, 60, 70, 255]), dispose: 0, blend: 0 },
      { x: 4, y: 4, width: 4, height: 4, rgba: solid(4, 4, [0, 255, 0, 128]), dispose: 2, blend: 1 },
      { x: 0, y: 0, width: 2, height: 2, rgba: solid(2, 2, [255, 255, 0, 255]), dispose: 1, blend: 0 },
    ],
  });
  const { states } = await loadApng(source);
  const output = await exportRange(source, 1, 2);
  const re = await reimportFromDisk(t, output);
  assert.equal(re.anim.frames.length, 2);
  assert.equal(re.anim.numPlays, 2);
  assert.deepEqual([...re.states[0].display], [...states[1].display]);
  assert.deepEqual([...re.states[1].display], [...states[2].display]);
  assert.deepEqual(px(re.states[0].display, 8, 5, 5), [25, 158, 35, 255]);
  assert.deepEqual(
    px(re.states[0].display, 8, 0, 0),
    [50, 60, 70, 255],
    "选段首帧把源默认图的历史也烘焙进完整画布",
  );
  // 海报即该帧本身（IDAT = 第一帧），不是源默认海报（源海报在 (5,5) 仍是纯灰）
  assert.equal(re.anim.defaultImageCompressed, null);
  assert.notDeepEqual(px(re.anim.frames[0].pixels, 8, 5, 5), [50, 60, 70, 255]);
});

test("非法范围一律拒绝", async () => {
  const source = trickySource();
  const cases = [
    [2, 1, "起始晚于结束"],
    [0, 4, "结束越界"],
    [4, 5, "起止都越界"],
    [-1, 1, "负数起点"],
    [1.5, 2, "非整数"],
    [NaN, 1, "NaN"],
  ];
  for (const [first, last, label] of cases) {
    await assert.rejects(
      () => exportRange(source, first, last),
      (err) => err instanceof PngError,
      label,
    );
  }
});

test("静态 PNG（无 acTL）拒绝导出", async () => {
  const staticBytes = concatBytes(
    SIGNATURE,
    ihdr(4, 4),
    idatFromRgba(solid(4, 4, [1, 2, 3, 255]), 4, 4),
    chunk("IEND"),
  );
  await assert.rejects(() => exportRange(staticBytes, 0, 0), /不是动画/);
});

test("损坏源文件拒绝导出", async () => {
  const source = trickySource();
  const bad = source.slice();
  const idx = bad.findIndex(
    (v, i) =>
      v === 0x66 && bad[i + 1] === 0x64 &&
      bad[i + 2] === 0x41 && bad[i + 3] === 0x54,
  );
  assert.ok(idx > 0);
  bad[idx + 8] ^= 0xff; // CRC 失效
  await assert.rejects(() => exportRange(bad, 0, 1), /CRC/);
  await assert.rejects(() => exportRange(new Uint8Array(3), 0, 0), PngError);
});

test("输出超过 64 KiB 拒绝（源文件本身在限制内），同源较短区间仍可导出", async (t) => {
  // 第 1 帧铺满 64×64 不透明噪声（历史使之后每一帧展示图都全屏高熵、
  // 无法压缩），后续 15 帧只改 8×8 小方块：源文件很小，
  // 但烘焙成全画布帧后每帧约 16 KiB。
  const W = 64,
    H = 64;
  // xorshift32 取高字节，熵足以对抗 zlib（LCG 低字节会被逐行相关压缩）
  let seed = 2463534242;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed >>> 24;
  };
  const noise = (w, h) => {
    const out = new Uint8Array(w * h * 4);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = rand();
      out[i + 1] = rand();
      out[i + 2] = rand();
      out[i + 3] = 255;
    }
    return out;
  };
  const frames = [
    { width: W, height: H, x: 0, y: 0, rgba: noise(W, H), dispose: 0, blend: 0 },
  ];
  // 15 个 8×8 不透明噪声小方块，放在 4×4 网格内、互不重叠
  for (let k = 0; k < 15; k++) {
    frames.push({
      width: 8,
      height: 8,
      x: (k % 4) * 16,
      y: Math.floor(k / 4) * 16,
      rgba: noise(8, 8),
      dispose: 0,
      blend: 0,
    });
  }
  const source = buildApng({
    width: W,
    height: H,
    defaultImage: solid(W, H, [0, 0, 0, 255]),
    frames,
  });
  assert.ok(source.length <= 64 * 1024, `源文件 ${source.length} 字节须在限制内`);

  // 4 个全屏烘焙帧 ≈ 56 KiB，合法且像素可复核
  const short = await exportRange(source, 0, 3);
  assert.ok(short.length <= 64 * 1024);
  const re = await reimportFromDisk(t, short);
  assert.equal(re.anim.frames.length, 4);

  // 5 个全屏烘焙帧 > 64 KiB：拒绝
  await assert.rejects(
    () => exportRange(source, 0, 4),
    /64 KiB/,
  );
  // 全选 16 帧同样拒绝
  await assert.rejects(() => exportRange(source, 0, 15), PngError);
});
