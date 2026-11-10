/**
 * Safety class: TOUCHES PROVIDER, SENSITIVE (records your manual login, redacted; no DB writes).
 *
 * Record a MANUAL Isracard login for contract comparison.
 *
 * Opens the persistent real-Chrome profile on the login page and waits for
 * YOU to log in by hand. Meanwhile it records every request/response to the
 * provider's service endpoints (method, URL, headers subset, bodies) with the
 * stored credential values and tokens redacted. It stops once performLogonI
 * has answered (or after 4 minutes) and does not touch the database.
 *
 * Usage: npx tsx scripts/diagnostics/isracard-record-manual-login.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { HTTPRequest, HTTPResponse } from 'puppeteer';
import { decryptSecret } from '../../src/lib/security/crypto';
import { launchIsracardBrowser, resolveIsracardBrowserLaunch } from '../../src/lib/services/isracardBrowser';

try {
  process.loadEnvFile('.env');
} catch {
  // rely on environment / Keychain
}

const LOGIN_URL = 'https://digital.isracard.co.il/personalarea/Login';
const WAIT_MS = 4 * 60_000;
const REQUEST_HEADER_ALLOWLIST = ['content-type', 'accept', 'x-requested-with', 'origin', 'referer'];
const RESPONSE_HEADER_ALLOWLIST = ['content-type', 'server', 'cf-ray', 'cf-mitigated', 'location'];

type Entry = {
  seq: number;
  at: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
};

function pick(h: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) if (h[n] !== undefined) out[n] = h[n];
  return out;
}

function makeRedactor(secrets: string[]) {
  const ordered = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
  return (text: string): string => {
    let out = text;
    for (const s of ordered) out = out.split(s).join('<redacted>');
    out = out.replace(/([A-Za-z0-9+/_-]{40,})/g, '<tok>');
    out = out.replace(
      /("(?:userName|KodMishtamesh|fullCardNumber|idNumber|firstName|lastName|Sisma|sisma|password|MisparZihuy|cardSuffix|instanceId)"\s*:\s*")[^"]*(")/gi,
      '$1<redacted>$2',
    );
    out = out.replace(/((?:Sisma|sisma|password|MisparZihuy|KodMishtamesh|cardSuffix|instanceId|id)=)[^&\s"]*/gi, '$1<redacted>');
    return out;
  };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const rows = await prisma.$queryRaw<Array<{ encryptedData: string; iv: string; authTag: string }>>`
    SELECT "encryptedData", "iv", "authTag" FROM "BankCredential" WHERE provider = 'isracard' LIMIT 1`;
  await prisma.$disconnect();
  const row = rows[0];
  if (!row) throw new Error('No isracard credential stored.');
  const fields = JSON.parse(
    decryptSecret({ ciphertext: row.encryptedData, iv: row.iv, tag: row.authTag }),
  ) as Record<string, string>;
  const redact = makeRedactor(Object.values(fields));

  const launch = resolveIsracardBrowserLaunch({ ...process.env, ISRACARD_HEADLESS: 'false' }, process.platform);
  if (!launch) throw new Error('Requires a host browser (macOS Chrome or ISRACARD_EXECUTABLE_PATH).');
  const browser = await launchIsracardBrowser(launch);
  const entries: Entry[] = [];
  const byRequest = new Map<HTTPRequest, Entry>();
  let seq = 0;
  let done: (reason: string) => void = () => undefined;
  const finished = new Promise<string>((resolve) => {
    done = resolve;
  });

  try {
    const page = await browser.newPage();
    page.on('request', (request: HTTPRequest) => {
      const url = request.url();
      if (!/isracard\.co\.il\/(services|ocp|Recaptcha|personalarea\/(Login|dashboard))/i.test(url)) return;
      const headers = request.headers();
      const requestHeaders = pick(headers, REQUEST_HEADER_ALLOWLIST);
      if (headers['__requestverificationtoken']) requestHeaders.__RequestVerificationToken = '<present>';
      const entry: Entry = {
        seq: ++seq,
        at: new Date().toISOString(),
        method: request.method(),
        url: url.replace(/(reqName=[A-Za-z]+)[^#]*/, '$1'),
        requestHeaders,
      };
      const body = request.postData();
      if (body) entry.requestBody = redact(body).slice(0, 3000);
      entries.push(entry);
      byRequest.set(request, entry);
    });
    page.on('response', async (response: HTTPResponse) => {
      const entry = byRequest.get(response.request());
      if (!entry) return;
      entry.status = response.status();
      entry.responseHeaders = pick(response.headers(), RESPONSE_HEADER_ALLOWLIST);
      if (/ProxyRequestHandler|Recaptcha/i.test(response.url())) {
        try {
          entry.responseBody = redact(await response.text()).slice(0, 3000);
        } catch {
          entry.responseBody = '<unavailable>';
        }
        if (/reqName=performLogonI/i.test(response.url())) {
          setTimeout(() => done('performLogonI answered'), 4_000);
        }
      }
    });

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    console.log('[record] Chrome is open. Log in by hand in that window (fixed password). Recording…');
    const timer = setTimeout(() => done('timeout'), WAIT_MS);
    const reason = await finished;
    clearTimeout(timer);
    console.log(`[record] stopped: ${reason}`);
  } finally {
    await browser.close();
    const outDir = path.resolve('debug-screenshots');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `isracard-manual-login-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(outFile, JSON.stringify(entries, null, 2), { mode: 0o600 });
    for (const e of entries.filter((x) => /ProxyRequestHandler|Recaptcha/i.test(x.url))) {
      console.log(`${e.seq} ${e.method} ${e.status} ${e.url.slice(-45)} ct=${e.requestHeaders['content-type'] ?? '-'} token=${e.requestHeaders.__RequestVerificationToken ?? '-'}`);
      if (e.requestBody) console.log('   req:', e.requestBody.slice(0, 400));
      if (e.responseBody) console.log('   res:', e.responseBody.slice(0, 300));
    }
    console.log(`[record] capture -> ${outFile}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
