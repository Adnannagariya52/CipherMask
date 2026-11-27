import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const IS_CLOUD_PROFILE = process.env.VITE_CLOUD_PROFILE === 'enabled';

const PRODUCTION_CSP = [
  "default-src 'self'",
  IS_CLOUD_PROFILE
    ? "connect-src 'self' https://generativelanguage.googleapis.com http://127.0.0.1:8787"
    : "connect-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "img-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function walkFiles(dir: string, rootDir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, rootDir, out);
    } else if (entry.isFile()) {
      out.push('/' + path.relative(rootDir, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

function cipherMaskBuildPlugin(): Plugin {
  let isBuild = false;
  let outDir = 'dist';
  return {
    name: 'ciphermask-offline-and-csp',
    configResolved(config) {
      isBuild = config.command === 'build';
      outDir = path.resolve(config.root, config.build.outDir);
    },
    transformIndexHtml(html) {
      if (!isBuild) return html;
      const metaTag = `    <meta http-equiv="Content-Security-Policy" content="${PRODUCTION_CSP}" />\n`;
      return html.replace('<!--PROD_CSP-->', metaTag);
    },
    closeBundle() {
      if (!isBuild || !fs.existsSync(outDir)) return;
      const allFiles = walkFiles(outDir, outDir);
      const shellAssets: string[] = ['/'];
      const modelAssets: string[] = [];

      for (const rel of allFiles) {
        if (rel === '/sw.js' || rel === '/precache-manifest.json' || rel === '/_headers') continue;
        // Never eagerly cache multi-GB Gemma model weights during SW install
        if (rel.startsWith('/models/')) continue;
        if (rel.startsWith('/assets/ocr/') || rel.startsWith('/assets/vision/') || rel.startsWith('/assets/ner/') || rel.startsWith('/wasm/')) {
          modelAssets.push(rel);
        } else {
          shellAssets.push(rel);
        }
      }

      const versionHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ shellAssets, modelAssets }))
        .digest('hex')
        .slice(0, 12);

      const manifest = {
        version: `ciphermask-${versionHash}`,
        generatedAt: new Date().toISOString(),
        shellAssets: Array.from(new Set(shellAssets)).sort(),
        modelAssets: Array.from(new Set(modelAssets)).sort(),
      };

      fs.writeFileSync(
        path.join(outDir, 'precache-manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );

      const headersContent = `/*
  Content-Security-Policy: ${PRODUCTION_CSP}; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=()
`;
      fs.writeFileSync(path.join(outDir, '_headers'), headersContent, 'utf-8');
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cipherMaskBuildPlugin()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers', '@mediapipe/tasks-vision', '@mediapipe/tasks-genai', 'tesseract.js'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
