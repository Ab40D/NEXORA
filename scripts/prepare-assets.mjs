#!/usr/bin/env node
/**
 * Prepares self-hosted computer-vision assets so the browser never needs a
 * third-party CDN for hand tracking:
 *
 *  1. Copies the MediaPipe Tasks Vision WASM runtime from node_modules into
 *     public/mediapipe/wasm (gitignored, regenerated on install/build).
 *  2. Ensures public/models/hand_landmarker.task exists and matches the pinned
 *     SHA-256. If missing, it is downloaded once from Google's model bucket.
 *
 * Camera frames are processed locally in the browser by this WASM runtime;
 * nothing here uploads video anywhere.
 *
 * Flags:
 *   --wasm-only   only copy the WASM runtime (used by `postinstall`)
 *   --offline     never download; fail if the model is missing
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));

const WASM_SRC = path.join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const WASM_DST = path.join(root, "public", "mediapipe", "wasm");

const MODEL_PATH = path.join(root, "public", "models", "hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1";

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

async function copyWasm() {
  if (!(await exists(WASM_SRC))) {
    console.warn(`[assets] MediaPipe WASM not found at ${WASM_SRC} (dependencies not installed yet?) — skipping.`);
    return;
  }
  await mkdir(WASM_DST, { recursive: true });
  const files = (await readdir(WASM_SRC)).filter((f) => f.endsWith(".js") || f.endsWith(".wasm"));
  let copied = 0;
  for (const f of files) {
    const src = path.join(WASM_SRC, f);
    const dst = path.join(WASM_DST, f);
    const [s, d] = await Promise.all([stat(src), exists(dst).then((e) => (e ? stat(dst) : null))]);
    if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) continue;
    await copyFile(src, dst);
    copied++;
  }
  console.log(`[assets] MediaPipe WASM runtime ready (${files.length} files, ${copied} updated).`);
}

async function ensureModel() {
  if (await exists(MODEL_PATH)) {
    const digest = await sha256(MODEL_PATH);
    if (digest === MODEL_SHA256) {
      console.log("[assets] Hand landmark model present and verified.");
      return;
    }
    console.warn("[assets] Hand landmark model checksum mismatch — re-downloading.");
  }
  if (args.has("--offline")) {
    throw new Error(`[assets] ${MODEL_PATH} missing and --offline was given.`);
  }
  console.log(`[assets] Downloading hand landmark model from ${MODEL_URL} ...`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`[assets] Model download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const digest = createHash("sha256").update(buf).digest("hex");
  if (digest !== MODEL_SHA256) {
    throw new Error(`[assets] Downloaded model checksum mismatch (${digest}). Refusing to use it.`);
  }
  await mkdir(path.dirname(MODEL_PATH), { recursive: true });
  await writeFile(MODEL_PATH, buf);
  console.log("[assets] Hand landmark model downloaded and verified.");
}

try {
  await copyWasm();
  if (!args.has("--wasm-only")) await ensureModel();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
