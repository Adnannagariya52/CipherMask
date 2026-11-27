import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SENTINELS = ['priya.sharma@example.org', '2345 6789 0124', '4111 1111 1111 1111', 'ABCDE1234F'];

test.describe('CipherMask Production Preview E2E', () => {
  test('Text Shield: noisy sample, 3 modes, Luhn/Verhoeff rejections, XSS safety, TXT upload & download, zero external network', async ({ page }) => {
    const externalRequests: string[] = [];
    const leakedInNetwork: string[] = [];

    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('http://127.0.0.1:4174') && !url.startsWith('blob:') && !url.startsWith('data:')) {
        externalRequests.push(url);
      }
      const post = req.postData() || '';
      for (const s of SENTINELS) {
        if (url.includes(s) || post.includes(s)) {
          leakedInNetwork.push(url);
        }
      }
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Text Shield' })).toBeVisible();

    // Load one-click noisy sample
    await page.getByTestId('load-noisy-sample-btn').click();
    await expect(page.getByTestId('stat-total')).toHaveText('11');
    await expect(page.getByTestId('stat-rejected')).toHaveText('4');

    // Verify rejected invalid card 4111 1111 1111 1112 is listed in Rejected inspector
    await page.getByTestId('inspector-tab-rejected').click();
    await expect(page.getByText(/Failed Luhn mod-10 checksum/)).toBeVisible();

    // Verify Full Mask mode
    await expect(page.getByTestId('sanitized-output-pane')).toContainText('[REDACTED]');
    await expect(page.getByTestId('sanitized-output-pane')).not.toContainText('priya.sharma@example.org');

    // Switch to Partial Mask
    await page.getByTestId('mode-partial').click();
    await expect(page.getByTestId('sanitized-output-pane')).toContainText('XXXX XXXX XXXX 1111');
    await expect(page.getByTestId('sanitized-output-pane')).toContainText('XXXX XXXX 0124');

    // Switch to Consistent Pseudonym and verify repeated email gets EMAIL_01 twice
    await page.getByTestId('mode-pseudonym').click();
    await expect(page.getByTestId('sanitized-output-pane')).toContainText('EMAIL_01');
    const outText = await page.getByTestId('sanitized-output-pane').innerText();
    const email01Matches = outText.match(/EMAIL_01/g) ?? [];
    expect(email01Matches.length).toBe(2);
    expect(outText).toContain('EMAIL_02'); // obfuscated email

    // Export TXT download and inspect exact downloaded file
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-txt-btn').click(),
    ]);
    const dlPath = await download.path();
    expect(dlPath).toBeTruthy();
    const dlContent = fs.readFileSync(dlPath!, 'utf-8');
    expect(dlContent).not.toContain('priya.sharma@example.org');
    expect(dlContent).toContain('EMAIL_01');

    // XSS injection test: script tag renders as literal text, never executes
    await page.getByTestId('raw-text-input').fill('<script>window.__cmXss=true;</script> test@example.org');
    await expect(page.getByTestId('annotated-original-pane')).toContainText('<script>window.__cmXss=true;</script>');
    const xssFlag = await page.evaluate(() => (window as unknown as { __cmXss?: boolean }).__cmXss);
    expect(xssFlag).toBeUndefined();

    // Upload TXT fixture via file chooser
    const tmpTxt = path.join(test.info().outputDir, 'upload-test.txt');
    fs.mkdirSync(test.info().outputDir, { recursive: true });
    fs.writeFileSync(tmpTxt, 'Uploaded email bob@example.net and IP 10.0.0.9', 'utf-8');
    await page.getByTestId('text-file-input').setInputFiles(tmpTxt);
    await expect(page.getByTestId('stat-total')).toHaveText('2');

    // Verify no sensitive persistence in localStorage/sessionStorage
    const storageCounts = await page.evaluate(() => ({
      local: window.localStorage.length,
      session: window.sessionStorage.length,
    }));
    expect(storageCounts.local).toBe(0);
    expect(storageCounts.session).toBe(0);

    expect(externalRequests).toEqual([]);
    expect(leakedInNetwork).toEqual([]);
  });

  test('Data Shield: CSV risk cohort, k-anonymity before/after optimization, and CSV export', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-data').click();
    await page.getByTestId('load-csv-risk-btn').click();

    await expect(page.getByTestId('csv-data-table')).toBeVisible();
    await expect(page.getByTestId('csv-kmin-stat')).toContainText('1 →');

    await page.getByTestId('run-optimizer-btn').click();
    await expect(page.getByTestId('csv-kmin-stat')).toContainText('1 → 2', { timeout: 15_000 });
    await expect(page.getByTestId('csv-singletons-stat')).toContainText('→ 0');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-csv-btn').click(),
    ]);
    const csvPath = await download.path();
    const csvOut = fs.readFileSync(csvPath!, 'utf-8');
    expect(csvOut).not.toContain('aarav.mehta@example.org');
    expect(csvOut.trim().split('\n').length).toBe(17); // header + 16 data rows preserved
  });

  test('Vision Shield: real OCR + jsQR on synthetic PNG, BlazeFace portrait, manual box, and flattened PNG export', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-vision').click();

    // 1. Load synthetic ticket + QR PNG and run real local OCR + jsQR
    await page.getByTestId('load-vision-ticket-btn').click();
    await expect(page.getByTestId('vision-source-canvas')).toBeVisible();

    await page.getByTestId('vision-scan-ocr-btn').click();
    await expect(page.getByText(/QR Code/i).first()).toBeVisible({ timeout: 30_000 });

    // Add manual numeric box (keyboard accessible)
    await page.getByTestId('vision-add-manual-box-btn').click();

    const [dlPng] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('vision-export-btn').click(),
    ]);
    const pngPath = await dlPng.path();
    const pngBytes = fs.readFileSync(pngPath!);
    // Verify PNG signature
    expect(pngBytes[0]).toBe(0x89);
    expect(pngBytes[1]).toBe(0x50);
    await expect(page.getByTestId('vision-export-status')).toContainText('Opaque masks verified');

    // 2. Load bundled Apache-2.0 portrait and run real local MediaPipe FaceDetector
    await page.getByTestId('load-vision-portrait-btn').click();
    await page.getByTestId('vision-scan-faces-btn').click();
    await expect(page.getByText(/FACE_01|Face/i).first()).toBeVisible({ timeout: 25_000 });
  });

  test('Benchmark Lab, Prompt Log, and Offline Service Worker reload', async ({ page, context }) => {
    await page.goto('/');

    // Benchmark Lab
    await page.getByTestId('nav-benchmark').click();
    await page.getByTestId('run-benchmark-btn').click();
    await expect(page.getByTestId('benchmark-table')).toBeVisible();
    await expect(page.getByTestId('benchmark-table')).toContainText('OVERALL');

    // Audit & Receipt Integrity Checker E2E
    await page.getByTestId('nav-text').click();
    await page.getByTestId('load-noisy-sample-btn').click();
    await page.getByTestId('mode-pseudonym').click();
    await expect(page.getByTestId('sanitized-output-pane')).toContainText('EMAIL_01');
    const [dlTxt] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-txt-btn').click(),
    ]);
    const sanTxtPath = await dlTxt.path();
    await page.getByTestId('nav-audit').click();
    await expect(page.getByTestId('receipt-sha256')).toBeVisible();
    const [dlReceipt] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-receipt-btn').click(),
    ]);
    const receiptPath = await dlReceipt.path();
    await page.getByTestId('verify-artifact-input').setInputFiles(sanTxtPath!);
    await page.getByTestId('verify-receipt-input').setInputFiles(receiptPath!);
    await page.getByTestId('verify-receipt-submit').click();
    await expect(page.getByTestId('verify-receipt-outcome')).toContainText('SHA-256 digest and byte length match');

    // Prompt Log
    await page.getByTestId('nav-promptLog').click();
    await expect(page.getByTestId('prompt-log-content')).toContainText('CipherMask Prompt Log');

    // Wait for SW registration & activation on production preview
    await page.getByTestId('nav-privacy').click();
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });
    await page.reload();
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) {
        await navigator.serviceWorker.ready;
      }
    });

    // Go offline and verify reload + Text Shield processing + download still work
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Text Shield' })).toBeVisible();
    await page.getByTestId('load-noisy-sample-btn').click();
    await expect(page.getByTestId('stat-total')).toHaveText('11');
    await expect(page.getByTestId('sanitized-output-pane')).toContainText('[REDACTED]');
    await context.setOffline(false);
  });
});
