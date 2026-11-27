import { test, expect } from '@playwright/test';

const RAW_SENTINELS = ['priya.sharma@example.org', '98765 43210', '4111 1111 1111 1111'];

test.describe('CipherMask V2 Live Protected Cloud + Relay E2E', () => {
  test('Auto-selects Gemini model, enforces approval firewall, sends sanitized multi-turn requests, and keeps restored PII local', async ({ page }) => {
    const relayPosts: string[] = [];

    page.on('request', (req) => {
      if (req.url().includes('127.0.0.1:8787/api/gemini') && req.method() === 'POST') {
        relayPosts.push(req.postData() || '');
      }
    });

    await page.goto('/');
    await page.getByTestId('nav-setup').click();
    await expect(page.getByTestId('cloud-profile-badge')).toContainText('CLOUD PROFILE BUILD');

    // Enable organizer permission and run Auto-Select against live relay
    await page.getByRole('checkbox', { name: /Organizer \/ Owner explicitly authorized/i }).check();
    await page.getByRole('button', { name: 'Auto-Select' }).click();
    await expect(page.getByText(/Validated Gemini Flash model/i)).toBeVisible({ timeout: 20_000 });

    // Switch to CipherChat -> Protected Cloud mode
    await page.getByTestId('nav-chat').click();
    await page.getByTestId('chat-mode-cloud').click();
    await page.getByTestId('chat-load-demo-btn').click();

    // Turn 1: Sanitize first -> verify no relay request sent during sanitize
    await page.getByTestId('chat-sanitize-btn').click();
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('APPROVAL_READY', { timeout: 15_000 });
    expect(relayPosts.length).toBe(0);

    // Approve & Send sanitized payload to live Gemini via loopback relay
    await page.getByTestId('chat-approve-send-btn').click();
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('DISPLAY', { timeout: 30_000 });
    expect(relayPosts.length).toBe(1);

    // Verify zero raw sentinels inside outbound relay body
    for (const s of RAW_SENTINELS) {
      expect(relayPosts[0]).not.toContain(s);
    }

    // Reveal local placeholders on assistant response
    const revealBtn = page.getByRole('button', { name: /Reveal Known Placeholders Locally/i }).first();
    if (await revealBtn.isVisible()) {
      await revealBtn.click();
      await expect(page.getByText(/Local-Only Restored View/i)).toBeVisible();
    }

    // Turn 2: Follow-up question -> verify restored PII is NOT included in Turn 2 outbound history
    await page.getByTestId('chat-composer-input').fill('Keep the reply under 2 sentences and confirm GATEWAY_TIMEOUT.');
    await page.getByTestId('chat-sanitize-btn').click();
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('APPROVAL_READY', { timeout: 15_000 });
    await page.getByTestId('chat-approve-send-btn').click();
    await expect(page.getByTestId('chat-workflow-phase')).toHaveText('DISPLAY', { timeout: 30_000 });

    expect(relayPosts.length).toBe(2);
    for (const s of RAW_SENTINELS) {
      expect(relayPosts[1]).not.toContain(s);
    }

    // Direct relay defense-in-depth check: raw email must be rejected with HTTP 422
    const directRes = await page.evaluate(async () => {
      const r = await fetch('http://127.0.0.1:8787/api/gemini', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schemaVersion: 1,
          provider: 'gemini',
          model: 'gemini-flash-lite-latest',
          systemInstruction: 'Test',
          history: [],
          currentPrompt: 'Raw email leak@example.org',
          sanitizedAttachments: [],
          sanitizedImages: [],
        }),
      });
      return r.status;
    });
    expect(directRes).toBe(422);
  });
});
