import { parsePng, PngError, LIMITS } from "./png-chunks.js";
import { assembleApng } from "./apng.js";
import { decodePngPixels } from "./png-decode.js";
import { computeFrameStates } from "./compositor.js";
import { deflate } from "./png-encode.js";
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
  new DataView(out.buffer).setUint32(0, value);
  return out;
}
function control(sequence, frame) {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  for (const [offset, value] of [
    [0, sequence],
    [4, frame.width],
    [8, frame.height],
    [12, frame.x],
    [16, frame.y],
  ])
    view.setUint32(offset, value);
  view.setUint16(20, frame.delayNum);
  view.setUint16(22, frame.delayDen);
  out[24] = frame.dispose;
  out[25] = frame.blend;
  return chunk("fcTL", out);
}
export async function exportRange(bytes, first, last) {
  const parsed = parsePng(bytes),
    anim = assembleApng(parsed);
  const frames = anim.frames.slice(first, last + 1);
  const parts = [
    bytes.slice(0, 8),
    chunk("IHDR", parsed.chunks.find((c) => c.type === "IHDR").data),
    chunk("acTL", join([word(frames.length), word(anim.numPlays)])),
  ];
  let sequence = first;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    parts.push(control(sequence++, frame));
    parts.push(
      i === 0
        ? chunk("IDAT", frame.compressed)
        : chunk("fdAT", join([word(sequence++), frame.compressed])),
    );
  }
  parts.push(chunk("IEND", new Uint8Array()));
  return join(parts);
}
