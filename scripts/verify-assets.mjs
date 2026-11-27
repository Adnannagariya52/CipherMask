import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const ASSETS_DIR = path.resolve(ROOT, 'public', 'assets');
const MANIFEST_PATH = path.join(ASSETS_DIR, 'manifest.json');

function safeDest(relPath) {
  const clean = relPath.replace(/^\/+/, '');
  const resolved = path.resolve(ASSETS_DIR, clean);
  if (!resolved.startsWith(ASSETS_DIR + path.sep)) {
    throw new Error(`Unsafe asset path in manifest: ${relPath}`);
  }
  return resolved;
}

function main() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error('Missing public/assets/manifest.json. Run: npm run setup:assets');
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  if (assets.length === 0) {
    console.error('Asset manifest contains 0 entries.');
    process.exit(1);
  }

  let requiredFailures = 0;
  let optionalUnavailable = 0;
  const featureSummary = {};

  for (const entry of assets) {
    const feat = entry.feature || 'other';
    if (!featureSummary[feat]) {
      featureSummary[feat] = { ready: 0, missing: 0, totalBytes: 0 };
    }

    if (entry.status !== 'ready') {
      featureSummary[feat].missing += 1;
      if (entry.required) {
        console.error(`[FAIL] Required asset not ready: ${entry.id} (${entry.error || 'unknown'})`);
        requiredFailures += 1;
      } else {
        console.warn(`[WARN] Optional asset unavailable: ${entry.id}`);
        optionalUnavailable += 1;
      }
      continue;
    }

    const fullPath = safeDest(entry.dest);
    if (!fs.existsSync(fullPath)) {
      featureSummary[feat].missing += 1;
      if (entry.required) {
        console.error(`[FAIL] Missing file on disk: ${entry.dest}`);
        requiredFailures += 1;
      } else {
        console.warn(`[WARN] Optional file missing on disk: ${entry.dest}`);
        optionalUnavailable += 1;
      }
      continue;
    }

    const data = fs.readFileSync(fullPath);
    if (data.length === 0 || data.length !== entry.size) {
      featureSummary[feat].missing += 1;
      console.error(`[FAIL] Size mismatch for ${entry.id}: expected ${entry.size}, got ${data.length}`);
      if (entry.required) requiredFailures += 1;
      else optionalUnavailable += 1;
      continue;
    }

    const actualSha = crypto.createHash('sha256').update(data).digest('hex');
    if (actualSha !== entry.sha256) {
      featureSummary[feat].missing += 1;
      console.error(`[FAIL] SHA-256 mismatch for ${entry.id}`);
      if (entry.required) requiredFailures += 1;
      else optionalUnavailable += 1;
      continue;
    }

    featureSummary[feat].ready += 1;
    featureSummary[feat].totalBytes += data.length;
  }

  console.log('Asset verification summary:');
  for (const [feat, info] of Object.entries(featureSummary)) {
    const mb = (info.totalBytes / (1024 * 1024)).toFixed(2);
    console.log(`  - ${feat}: ${info.ready} ready, ${info.missing} missing (${mb} MiB)`);
  }

  if (requiredFailures > 0) {
    console.error(`\nverify:assets FAILED with ${requiredFailures} required failure(s).`);
    process.exit(1);
  }

  console.log(`\nverify:assets PASSED (${optionalUnavailable} optional unavailable).`);
}

main();
