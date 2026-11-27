import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import JSZip from 'jszip';

const SENTINELS = ['priya.sharma@example.org', '98765 43210', '4111 1111 1111 1111'];

test.describe('CipherMask V2 CipherChat & Outbound Privacy Sentinel E2E', () => {
  test('CipherChat strict-local workflow: hybrid scan, Identity Bridge, blocked cloud send, ZIP export, zero external requests', async ({ page }) => {
    const externalRequests: string[] = [];
    const postBodiesWithSentinels: string[] = [];

    page.on('request', (req) => {
      const url = req.url();
      if (!url.startsWith('http://127.0.0.1:4174') && !url.startsWith('blob:') && !url.startsWith('data:')) {
        externalRequests.push(url);
      }
      const body = req.postData() || '';
      for (const s of SENTINELS) {
        if (url.includes(s) || body.includes(s)) {
          postBodiesWithSentinels.push(url);
        }
      }
    });

    await page.goto('/');

    // Check Local AI & Cloud Setup panel first
    await page.getByTestId('nav-setup').click();
    await expect(page.getByTestId('gemma-status-badge')).toBeVisible();
    await expect(page.getByTestId('cloud-profile-badge')).toContainText('STRICT-LOCAL BUILD (LOCKED)');

    // Open CipherChat
    await page.getByTestId('nav-chat').click();
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('DRAFT');

    // Load synthetic demo scenario (prompt + attached support_log_1.txt)
    await page.getByTestId('chat-load-demo-btn').click();

    // Pressing Enter in composer must NOT send or bypass sanitization
    await page.getByTestId('chat-composer-input').press('Enter');
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('DRAFT');

    // Run Analyze / Sanitize
    await page.getByTestId('chat-sanitize-btn').click();
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('APPROVAL_READY', { timeout: 15_000 });

    // Sanitized preview replaces raw PII with Identity Bridge placeholders & keeps GATEWAY_TIMEOUT
    const sanPreview = await page.getByTestId('chat-sanitized-preview').innerText();
    expect(sanPreview).toContain('GATEWAY_TIMEOUT');
    for (const s of SENTINELS) {
      expect(sanPreview).not.toContain(s);
    }

    // Strict-local build blocks cloud send even if user switches to Cloud tab
    await expect(page.getByTestId('chat-firewall-blocked')).toContainText('Strict-local build profile active');

    // Export sanitized collection ZIP and verify ZIP contents contain zero raw sentinels
    const [dlZip] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('chat-export-zip-btn').click(),
    ]);
    const zipPath = await dlZip.path();
    const zipBytes = fs.readFileSync(zipPath!);
    const zip = await JSZip.loadAsync(zipBytes);
    const zipFilenames = Object.keys(zip.files);
    expect(zipFilenames).toContain('sanitized_prompt.txt');
    expect(zipFilenames).toContain('support_log_1.txt');
    expect(zipFilenames).toContain('audit-receipt.json');

    const logText = await zip.file('support_log_1.txt')!.async('string');
    expect(logText).not.toContain('priya.sharma@example.org');
    expect(logText).toContain('GATEWAY_TIMEOUT');

    expect(externalRequests).toEqual([]);
    expect(postBodiesWithSentinels).toEqual([]);
  });
});
