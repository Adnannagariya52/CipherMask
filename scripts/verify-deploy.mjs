import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.resolve(rootDir, 'dist');
const distModelsDir = path.join(distDir, 'models');

const FORBIDDEN_MODEL_EXTS = new Set(['.task', '.litertlm', '.gguf', '.safetensors', '.bin']);
const MAX_ALLOWED_FILE_BYTES = 115 * 1024 * 1024; // ONNX NER quantized model is ~104 MiB
const SECRET_PATTERNS = [
  /AIzaSy[0-9A-Za-z_-]{30,}/,
  /\bhf_[A-Za-z0-9]{30,}\b/,
  /GEMINI_API_KEY\s*=\s*[^\s"']{10,}/,
];

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

if (!fs.existsSync(distDir)) {
  console.error('[verify:deploy] FAIL: dist/ directory does not exist. Run `npm run build:strict` first.');
  process.exit(1);
}

// 1. Prune ONLY any copied Gemma model binaries inside dist/models/ (never touches public/models/)
let prunedCount = 0;
if (fs.existsSync(distModelsDir)) {
  for (const file of fs.readdirSync(distModelsDir)) {
    const ext = path.extname(file).toLowerCase();
    if (FORBIDDEN_MODEL_EXTS.has(ext) || ext === '.tmp') {
      fs.unlinkSync(path.join(distModelsDir, file));
      prunedCount += 1;
    }
  }
}

const files = walkFiles(distDir);
const relSet = new Set(files.map((f) => '/' + path.relative(distDir, f).replace(/\\/g, '/')));

// 2. Verify required shell & runtime files exist
const requiredFiles = [
  '/index.html',
  '/sw.js',
  '/precache-manifest.json',
  '/models/manifest.json',
  '/assets/manifest.json',
  '/wasm/genai/genai_wasm_internal.wasm',
  '/wasm/genai/genai_wasm_internal.js',
];
for (const req of requiredFiles) {
  if (!relSet.has(req)) {
    console.error(`[verify:deploy] FAIL: Missing required deployment artifact dist${req}`);
    process.exit(1);
  }
}

// 3. Enforce strict CSP inside dist/index.html
const indexHtml = fs.readFileSync(path.join(distDir, 'index.html'), 'utf-8');
if (!indexHtml.includes("connect-src 'self'")) {
  console.error("[verify:deploy] FAIL: Strict CSP `connect-src 'self'` is missing from dist/index.html.");
  process.exit(1);
}

// 4. Verify zero Gemma binaries, zero .env files, zero oversized blobs, and zero secrets in dist/
let totalBytes = 0;
const largeFiles = [];
for (const full of files) {
  const rel = '/' + path.relative(distDir, full).replace(/\\/g, '/');
  const ext = path.extname(full).toLowerCase();
  const base = path.basename(full).toLowerCase();
  const size = fs.statSync(full).size;
  totalBytes += size;

  if (FORBIDDEN_MODEL_EXTS.has(ext)) {
    console.error(`[verify:deploy] FAIL: Forbidden large model binary found in dist${rel}`);
    process.exit(1);
  }
  if (base.startsWith('.env')) {
    console.error(`[verify:deploy] FAIL: Environment file leaked into dist${rel}`);
    process.exit(1);
  }
  if (size > MAX_ALLOWED_FILE_BYTES) {
    console.error(`[verify:deploy] FAIL: Oversized file (${(size / 1048576).toFixed(1)} MiB) in dist${rel}`);
    process.exit(1);
  }
  if (size > 10 * 1024 * 1024) {
    largeFiles.push(`${rel} (${(size / 1048576).toFixed(1)} MiB)`);
  }

  if (['.js', '.mjs', '.html', '.json', '.css'].includes(ext) && size < 10 * 1024 * 1024) {
    const content = fs.readFileSync(full, 'utf-8');
    for (const pat of SECRET_PATTERNS) {
      if (pat.test(content)) {
        console.error(`[verify:deploy] FAIL: Potential secret pattern matched in dist${rel}`);
        process.exit(1);
      }
    }
  }
}

console.log(`[verify:deploy] PASSED: ${files.length} files (${(totalBytes / 1048576).toFixed(1)} MiB total), pruned=${prunedCount} Gemma binaries.`);
console.log('[verify:deploy] Largest runtime assets:', largeFiles.join(', '));
