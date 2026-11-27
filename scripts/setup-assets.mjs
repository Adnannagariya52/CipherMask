import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = process.cwd();
const ASSETS_DIR = path.resolve(ROOT, 'public', 'assets');
const MANIFEST_PATH = path.join(ASSETS_DIR, 'manifest.json');
const FORCE = process.argv.includes('--force');
const SKIP_NER = process.argv.includes('--skip-ner');

const NER_REVISION = '8e892123e8b7c2c0c2bd1dcb598b7d244c4e53aa';

function safeDest(relPath) {
  const clean = relPath.replace(/^\/+/, '');
  const resolved = path.resolve(ASSETS_DIR, clean);
  if (!resolved.startsWith(ASSETS_DIR + path.sep)) {
    throw new Error(`Unsafe asset path traversal detected: ${relPath}`);
  }
  return resolved;
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return { sha256: hash.digest('hex'), size: data.length };
}

function validateFileSignature(filePath, check) {
  const buf = fs.readFileSync(filePath);
  if (buf.length === 0) throw new Error(`Empty file: ${filePath}`);
  if (check === 'gzip') {
    if (buf.length < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new Error(`Invalid gzip magic bytes in ${filePath}`);
    }
  } else if (check === 'json') {
    JSON.parse(buf.toString('utf-8'));
  } else if (check === 'wasm') {
    if (buf.length < 4 || buf[0] !== 0x00 || buf[1] !== 0x61 || buf[2] !== 0x73 || buf[3] !== 0x6d) {
      throw new Error(`Invalid WASM magic bytes in ${filePath}`);
    }
  }
}

async function copyLocalAsset(spec) {
  const src = path.resolve(ROOT, spec.sourcePath);
  const dest = safeDest(spec.dest);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing node_modules asset: ${src}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.copyFileSync(src, tmp);
  validateFileSignature(tmp, spec.check);
  fs.renameSync(tmp, dest);
  const { sha256, size } = sha256File(dest);
  return {
    id: spec.id,
    feature: spec.feature,
    required: spec.required,
    source: spec.sourceLabel,
    dest: spec.dest,
    size,
    sha256,
    integritySource: 'local-package-digest',
    license: spec.license,
    status: 'ready',
  };
}

async function downloadRemoteAsset(spec, existingEntry) {
  const dest = safeDest(spec.dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (!FORCE && fs.existsSync(dest) && existingEntry?.sha256) {
    try {
      const current = sha256File(dest);
      if (current.sha256 === existingEntry.sha256 && current.size > 0) {
        validateFileSignature(dest, spec.check);
        console.log(`[skip] ${spec.id} (already verified)`);
        return {
          ...existingEntry,
          size: current.size,
          status: 'ready',
        };
      }
    } catch {
      // Re-download if existing file fails validation
    }
  }

  console.log(`[fetch] ${spec.id} <- ${spec.url}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);
  const tmp = `${dest}.tmp`;

  try {
    const res = await fetch(spec.url, {
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} for ${spec.url}`);
    }
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > spec.maxBytes) {
      throw new Error(`Asset ${spec.id} exceeds maxBytes (${contentLength} > ${spec.maxBytes})`);
    }
    if (!res.body) {
      throw new Error(`Empty response body for ${spec.url}`);
    }

    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
    const stat = fs.statSync(tmp);
    if (stat.size === 0 || stat.size > spec.maxBytes) {
      throw new Error(`Downloaded size invalid for ${spec.id}: ${stat.size} bytes`);
    }
    validateFileSignature(tmp, spec.check);
    fs.renameSync(tmp, dest);
    const { sha256, size } = sha256File(dest);
    console.log(`[ok]    ${spec.id} (${(size / 1024).toFixed(1)} KiB)`);
    return {
      id: spec.id,
      feature: spec.feature,
      required: spec.required,
      source: spec.url,
      revision: spec.revision || 'pinned',
      dest: spec.dest,
      size,
      sha256,
      integritySource: 'local-download-baseline',
      license: spec.license,
      status: 'ready',
    };
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    if (spec.required) {
      throw new Error(`Required asset ${spec.id} failed: ${err.message}`);
    }
    console.warn(`[warn]  Optional asset ${spec.id} unavailable: ${err.message}`);
    return {
      id: spec.id,
      feature: spec.feature,
      required: spec.required,
      source: spec.url,
      revision: spec.revision || 'pinned',
      dest: spec.dest,
      size: 0,
      sha256: null,
      integritySource: 'unavailable',
      license: spec.license,
      status: 'unavailable',
      error: err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  let existingManifest = { assets: [] };
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    } catch {
      existingManifest = { assets: [] };
    }
  }
  const byId = new Map((existingManifest.assets || []).map((a) => [a.id, a]));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

  const localSpecs = [
    {
      id: 'ocr-worker',
      feature: 'ocr',
      required: true,
      sourcePath: 'node_modules/tesseract.js/dist/worker.min.js',
      sourceLabel: `npm:tesseract.js@${pkg.dependencies['tesseract.js']}`,
      dest: 'ocr/worker/worker.min.js',
      license: 'Apache-2.0',
    },
    ...fs
      .readdirSync(path.join(ROOT, 'node_modules/tesseract.js-core'))
      .filter((f) => f.startsWith('tesseract-core') && (f.endsWith('.js') || f.endsWith('.wasm')))
      .map((f) => ({
        id: `ocr-core-${f}`,
        feature: 'ocr',
        required: true,
        sourcePath: `node_modules/tesseract.js-core/${f}`,
        sourceLabel: 'npm:tesseract.js-core@7.0.0',
        dest: `ocr/core/${f}`,
        license: 'Apache-2.0',
        check: f.endsWith('.wasm') ? 'wasm' : undefined,
      })),
    ...fs
      .readdirSync(path.join(ROOT, 'node_modules/@mediapipe/tasks-vision/wasm'))
      .map((f) => ({
        id: `vision-wasm-${f}`,
        feature: 'vision',
        required: true,
        sourcePath: `node_modules/@mediapipe/tasks-vision/wasm/${f}`,
        sourceLabel: `npm:@mediapipe/tasks-vision@${pkg.dependencies['@mediapipe/tasks-vision']}`,
        dest: `vision/wasm/${f}`,
        license: 'Apache-2.0',
        check: f.endsWith('.wasm') ? 'wasm' : undefined,
      })),
    ...[
      'ort-wasm-simd-threaded.asyncify.mjs',
      'ort-wasm-simd-threaded.asyncify.wasm',
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
    ].map((f) => ({
      id: `ner-wasm-${f}`,
      feature: 'ner',
      required: false,
      sourcePath: `node_modules/onnxruntime-web/dist/${f}`,
      sourceLabel: 'npm:onnxruntime-web (via @huggingface/transformers)',
      dest: `ner/wasm/${f}`,
      license: 'MIT',
      check: f.endsWith('.wasm') ? 'wasm' : undefined,
    })),
  ];

  const remoteSpecs = [
    {
      id: 'ocr-lang-eng',
      feature: 'ocr',
      required: true,
      url: 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0_fast/eng.traineddata.gz',
      revision: 'naptha/tessdata@4.0.0_fast',
      dest: 'ocr/lang/eng.traineddata.gz',
      maxBytes: 10 * 1024 * 1024,
      license: 'Apache-2.0',
      check: 'gzip',
    },
    {
      id: 'vision-face-detector',
      feature: 'vision',
      required: true,
      url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
      revision: 'blaze_face_short_range/float16/1',
      dest: 'vision/models/blaze_face_short_range.tflite',
      maxBytes: 5 * 1024 * 1024,
      license: 'Apache-2.0',
    },
    {
      id: 'vision-selfie-segmenter',
      feature: 'vision',
      required: false,
      url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
      revision: 'selfie_segmenter/float16/latest',
      dest: 'vision/models/selfie_segmenter.tflite',
      maxBytes: 5 * 1024 * 1024,
      license: 'Apache-2.0',
    },
    {
      id: 'sample-mediapipe-portrait',
      feature: 'vision',
      required: false,
      url: 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg',
      revision: 'mediapipe-assets/portrait.jpg',
      dest: 'samples/portrait.jpg',
      maxBytes: 2 * 1024 * 1024,
      license: 'Apache-2.0',
    },
  ];

  if (!SKIP_NER) {
    const nerBase = `https://huggingface.co/Xenova/bert-base-NER/resolve/${NER_REVISION}`;
    remoteSpecs.push(
      {
        id: 'ner-config',
        feature: 'ner',
        required: false,
        url: `${nerBase}/config.json`,
        revision: NER_REVISION,
        dest: 'ner/models/Xenova/bert-base-NER/config.json',
        maxBytes: 100_000,
        license: 'MIT',
        check: 'json',
      },
      {
        id: 'ner-tokenizer-config',
        feature: 'ner',
        required: false,
        url: `${nerBase}/tokenizer_config.json`,
        revision: NER_REVISION,
        dest: 'ner/models/Xenova/bert-base-NER/tokenizer_config.json',
        maxBytes: 100_000,
        license: 'MIT',
        check: 'json',
      },
      {
        id: 'ner-special-tokens',
        feature: 'ner',
        required: false,
        url: `${nerBase}/special_tokens_map.json`,
        revision: NER_REVISION,
        dest: 'ner/models/Xenova/bert-base-NER/special_tokens_map.json',
        maxBytes: 100_000,
        license: 'MIT',
        check: 'json',
      },
      {
        id: 'ner-tokenizer',
        feature: 'ner',
        required: false,
        url: `${nerBase}/tokenizer.json`,
        revision: NER_REVISION,
        dest: 'ner/models/Xenova/bert-base-NER/tokenizer.json',
        maxBytes: 5 * 1024 * 1024,
        license: 'MIT',
        check: 'json',
      },
      {
        id: 'ner-vocab',
        feature: 'ner',
        required: false,
        url: `${nerBase}/vocab.txt`,
        revision: NER_REVISION,
        dest: 'ner/models/Xenova/bert-base-NER/vocab.txt',
        maxBytes: 2 * 1024 * 1024,
        license: 'MIT',
      },
      {
        id: 'ner-model-q8',
        feature: 'ner',
        required: false,
        url: `${nerBase}/onnx/model_quantized.onnx`,
        revision: NER_REVISION,
        dest: 'ner/models/Xenova/bert-base-NER/onnx/model_quantized.onnx',
        maxBytes: 150 * 1024 * 1024,
        license: 'MIT',
      },
    );
  }

  const results = [];
  for (const spec of localSpecs) {
    results.push(await copyLocalAsset(spec));
  }
  for (const spec of remoteSpecs) {
    results.push(await downloadRemoteAsset(spec, byId.get(spec.id)));
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    assets: results,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`\nWrote manifest: ${MANIFEST_PATH} (${results.length} entries)`);
}

main().catch((err) => {
  console.error('\n[setup:assets FAILED]', err);
  process.exit(1);
});
