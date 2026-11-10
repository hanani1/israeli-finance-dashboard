import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The compatibility patch targets this versioned dependency seam directly.
const IsracardAmexBaseScraper = require(
  'israeli-bank-scrapers/lib/scrapers/base-isracard-amex',
).default;

type CapturedRequest = {
  url: string;
  options: RequestInit;
};

test('Isracard password login follows the public-site request sequence and JSON encoding', async () => {
  const requests: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, options });
    const requestName = new URL(requestUrl).searchParams.get('reqName');
    const responseByRequestName: Record<string, unknown> = {
      ValidateIdData: {
        Header: { Status: '1' },
        ValidateIdDataBean: { returnCode: '1', userName: 'fixture-user' },
      },
      performLogonI: { status: '1' },
    };

    return {
      status: 200,
      text: async () => JSON.stringify(responseByRequestName[requestName ?? '']),
    } as Response;
  }) as typeof fetch;

  const page = {
    setRequestInterception: async () => undefined,
    on: () => undefined,
    setUserAgent: async () => undefined,
    evaluate: async (callback: (...args: unknown[]) => unknown, ...args: unknown[]) => {
      if (args.length === 0) return 'HeadlessChrome/fixture';
      return callback(...args);
    },
  };
  const scraper = {
    page,
    baseUrl: 'https://fixture.invalid',
    servicesUrl: 'https://fixture.invalid/services/ProxyRequestHandler.ashx',
    companyCode: '11',
    navigateTo: async () => undefined,
    emitProgress: () => undefined,
  };

  try {
    const result = await IsracardAmexBaseScraper.prototype.login.call(scraper, {
      id: '123456789',
      card6Digits: '123456',
      password: 'Abc!12&xyz',
    });

    assert.deepEqual(result, { success: true });
    assert.deepEqual(
      requests.map(({ url }) => new URL(url).searchParams.get('reqName')),
      ['ValidateIdData', 'performLogonI'],
    );

    for (const { options } of requests) {
      assert.equal(
        (options.headers as Record<string, string>)['Content-Type'],
        'application/x-www-form-urlencoded; charset=UTF-8',
      );
      assert.equal(options.credentials, 'include');
      assert.equal(typeof options.body, 'string');
      assert.doesNotThrow(() => JSON.parse(String(options.body)));
    }

    const validateRequest = requests[0];
    const loginRequest = requests[1];
    assert.ok(validateRequest);
    assert.ok(loginRequest);
    const validateBody = JSON.parse(String(validateRequest.options.body));
    assert.deepEqual(validateBody, {
      id: '123456789',
      cardSuffix: '123456',
      countryCode: '212',
      idType: '1',
      checkLevel: '1',
      companyCode: '11',
    });
    const loginBody = JSON.parse(String(loginRequest.options.body));
    assert.deepEqual(loginBody, {
      KodMishtamesh: 'fixture-user',
      MisparZihuy: '123456789',
      Sisma: 'Abc!12&xyz',
      cardSuffix: '123456',
      countryCode: '212',
      idType: '1',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
