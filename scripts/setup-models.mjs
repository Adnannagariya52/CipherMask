import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const GENAI_WASM_SRC = path.resolve(ROOT, 'node_modules', '@mediapipe', 'tasks-genai', 'wasm');
const GENAI_WASM_DEST = path.resolve(ROOT, 'public', 'wasm', 'genai');
const MODELS_DIR = path.resolve(ROOT, 'public', 'models');
const MANIFEST_PATH = path.resolve(MODELS_DIR, 'manifest.json');

const EXPECTED_MODEL_FILENAME = 'gemma3-4b-it-int4-web.task';
const EXPECTED_MODEL_REPO = 'litert-community/Gemma3-4B-IT';
const EXPECTED_MODEL_URL = `https://huggingface.co/${EXPECTED_MODEL_REPO}/resolve/main/${EXPECTED_MODEL_FILENAME}`;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.readFileSync(filePath);
  hash.update(stream);
  return { sha256: hash.digest('hex'), size: stream.length };
}

function sha256FileStream(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    const rs = fs.createReadStream(filePath);
    rs.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    rs.on('end', () => resolve({ sha256: hash.digest('hex'), size }));
    rs.on('error', reject);
  });
}

async function main() {
  if (!fs.existsSync(GENAI_WASM_SRC)) {
    throw new Error(`Missing @mediapipe/tasks-genai/wasm at ${GENAI_WASM_SRC}. Run npm ci first.`);
  }

  fs.mkdirSync(GENAI_WASM_DEST, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });

  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(ROOT, 'node_modules', '@mediapipe', 'tasks-genai', 'package.json'), 'utf-8'),
  );

  const wasmEntries = [];
  for (const file of fs.readdirSync(GENAI_WASM_SRC)) {
    const src = path.join(GENAI_WASM_SRC, file);
    const dest = path.join(GENAI_WASM_DEST, file);
    if (!fs.statSync(src).isFile()) continue;
    const tmp = `${dest}.tmp`;
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
    const { sha256, size } = sha256File(dest);
    wasmEntries.push({
      id: `genai-wasm-${file}`,
      dest: `/wasm/genai/${file}`,
      size,
      sha256,
      source: `npm:@mediapipe/tasks-genai@${pkg.version}`,
      license: 'Apache-2.0',
      status: 'ready',
    });
  }

  const modelPath = path.join(MODELS_DIR, EXPECTED_MODEL_FILENAME);
  let modelEntry = {
    id: 'gemma-3-4b-it-int4-web',
    modelId: 'Gemma 3 4B Instruct (INT4 WebGPU)',
    repo: EXPECTED_MODEL_REPO,
    sourceUrl: EXPECTED_MODEL_URL,
    dest: `/models/${EXPECTED_MODEL_FILENAME}`,
    license: 'Gemma Terms of Use (gated repository)',
    runtimePackage: `@mediapipe/tasks-genai@${pkg.version}`,
    size: 0,
    sha256: null,
    integritySource: 'not-provisioned',
    status: 'needs-assets',
    notes:
      'Gated Hugging Face repository. Accept Gemma license at https://huggingface.co/litert-community/Gemma3-4B-IT, authenticate with hf auth login, and place gemma3-4b-it-int4-web.task in public/models/ or select the local file in CipherMask Setup UI.',
  };

  if (fs.existsSync(modelPath)) {
    const stat = fs.statSync(modelPath);
    if (stat.size > 1024 * 1024) {
      // Check it is not an HTML error/login page
      const fd = fs.openSync(modelPath, 'r');
      const head = Buffer.alloc(64);
      fs.readSync(fd, head, 0, 64, 0);
      fs.closeSync(fd);
      const headStr = head.toString('utf-8').trimStart();
      if (headStr.startsWith('<!DOCTYPE') || headStr.startsWith('<html') || headStr.startsWith('{')) {
        throw new Error(`Invalid model file at ${modelPath}: appears to be HTML/JSON error payload instead of binary .task artifact.`);
      }
      console.log(`[hash] Computing SHA-256 for ${EXPECTED_MODEL_FILENAME} (${(stat.size / (1024 ** 3)).toFixed(2)} GiB)...`);
      const digest = await sha256FileStream(modelPath);
      modelEntry = {
        ...modelEntry,
        size: digest.size,
        sha256: digest.sha256,
        integritySource: 'local-file-baseline',
        status: 'ready',
        notes: 'Verified local binary .task file present on disk.',
      };
    } else {
      throw new Error(`Model file ${modelPath} is suspiciously small (${stat.size} bytes).`);
    }
  } else {
    console.log(`[info] Optional/gated Gemma artifact not found at ${modelPath}.`);
    console.log(`       WASM runtime assets copied (${wasmEntries.length} files). To enable Gemma 3 4B:`);
    console.log(`       1. Accept license at https://huggingface.co/${EXPECTED_MODEL_REPO}`);
    console.log(`       2. Run: hf auth login`);
    console.log(`       3. Run: hf download ${EXPECTED_MODEL_REPO} ${EXPECTED_MODEL_FILENAME} --local-dir public/models`);
    console.log(`       Or select your local .task file directly inside the CipherMask Local AI Setup panel.`);
  }

  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtime: `@mediapipe/tasks-genai@${pkg.version}`,
    wasmAssets: wasmEntries,
    model: modelEntry,
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`\nWrote GenAI manifest: ${MANIFEST_PATH} (${wasmEntries.length} WASM files, model status: ${modelEntry.status})`);
}

main().catch((err) => {
  console.error('[setup:models FAILED]', err.message);
  process.exit(1);
});
