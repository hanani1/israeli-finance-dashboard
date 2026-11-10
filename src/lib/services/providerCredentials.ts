import { RequestError } from './requestError';

export type LoginFields = Record<string, string>;

const REQUIRED_LOGIN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  discount: ['id', 'password', 'num'],
  mercantile: ['id', 'password', 'num'],
};

const USERNAME_AS_NUM_PROVIDERS = new Set(['discount', 'mercantile']);
/**
 * Isracard's fixed-password rule, verified live on 2026-09-28: the login page
 * validates with /^(?=.*[0-9])(?=.*[a-zA-Z])([a-zA-Z0-9]+){8,20}$/ and its
 * `english-and-numbers` directive silently DROPS any other keystroke, so a
 * password a user believes contains punctuation is really the alphanumeric
 * remainder. Sent verbatim over the API, the punctuated form makes
 * performLogonI answer status -3 ("8-20 letters and digits"), which the
 * scraper reports as INVALID_PASSWORD.
 */
export const ISRACARD_PASSWORD_PATTERN = /^(?=.*[0-9])(?=.*[a-zA-Z])[a-zA-Z0-9]{8,20}$/;

/**
 * Convert legacy UI field names to the installed scraper's contract and reject
 * incomplete credentials before Puppeteer receives an undefined value.
 */
export function prepareLoginFields(provider: string, input: LoginFields): LoginFields {
  const fields = Object.fromEntries(
    Object.entries(input).filter(([, value]) => typeof value === 'string' && value.length > 0),
  );
  if (Object.keys(fields).length === 0) {
    throw new RequestError(400, 'At least one login field is required.');
  }

  if (provider === 'isracard' && fields.password && !ISRACARD_PASSWORD_PATTERN.test(fields.password)) {
    throw new RequestError(
      400,
      'Isracard password must be 8-20 Latin letters and digits with at least one of each. ' +
        "Isracard's login form silently drops other characters, so enter the letters and digits only.",
    );
  }

  if (USERNAME_AS_NUM_PROVIDERS.has(provider)) {
    if (!fields.num && fields.username) {
      fields.num = fields.username;
    }
    delete fields.username;
  }

  const requiredFields = REQUIRED_LOGIN_FIELDS[provider] ?? [];
  const missingFields = requiredFields.filter((field) => !fields[field]);
  if (missingFields.length > 0) {
    throw new RequestError(
      400,
      `Missing required login field(s) for ${provider}: ${missingFields.join(', ')}`,
    );
  }

  return fields;
}
