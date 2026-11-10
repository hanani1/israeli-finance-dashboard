import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Baseline hardening headers for every response (card #45, ADR-0019). The CSP
// deliberately sets only frame-ancestors (anti-clickjacking) so it cannot break
// Next.js inline scripts, recharts styles, or the PWA manifest.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Keep the scraper (and its Puppeteer dependency) out of the Next.js bundle —
  // it must be resolved from node_modules at runtime.
  serverExternalPackages: ['israeli-bank-scrapers', 'puppeteer'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default withNextIntl(nextConfig);
