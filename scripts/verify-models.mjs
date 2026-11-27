import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const MANIFEST_PATH = path.resolve(ROOT, 'public', 'models', 'manifest.json');

function sha256File(filePath) {
  const data = fs.readFileSync(filePath);
  return { sha256: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('Missing public/models/manifest.json. Run: npm run setup:models');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const wasmAssets = Array.isArray(manifest.wasmAssets) ? manifest.wasmAssets : [];
  let wasmFailures = 0;

  for (const w of wasmAssets) {
    const full = path.resolve(ROOT, 'public', w.dest.replace(/^\/+/, ''));
    if (!fs.existsSync(full)) {
      console.error(`[FAIL] Missing GenAI WASM runtime file: ${w.dest}`);
      wasmFailures += 1;
      continue;
    }
    const { sha256, size } = sha256File(full);
    if (size !== w.size || sha256 !== w.sha256) {
      console.error(`[FAIL] Checksum/size mismatch for ${w.dest}`);
      wasmFailures += 1;
    }
  }

  console.log(`GenAI WASM runtime: ${wasmAssets.length - wasmFailures}/${wasmAssets.length} verified.`);
  if (manifest.model?.status === 'ready') {
    const mPath = path.resolve(ROOT, 'public', manifest.model.dest.replace(/^\/+/, ''));
    console.log(`Gemma 3 4B model: READY (${manifest.model.dest}, ${(manifest.model.size / (1024 ** 3)).toFixed(2)} GiB, exists=${fs.existsSync(mPath)})`);
  } else {
    console.log(`Gemma 3 4B model: NEEDS ASSETS (gated repo; deterministic rule/OCR/CSV engine remains READY).`);
  }

  if (wasmFailures > 0) {
    process.exit(1);
  }
}

main();
