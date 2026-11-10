import assert from 'node:assert/strict';
import { test } from 'node:test';
import en from '../../../messages/en.json';
import he from '../../../messages/he.json';

// Every UI string must exist in both locales (card #51 added the shared
// ConfirmDialog / API-error keys). A missing key renders the raw key path.

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

test('en and he message catalogs have the same keys', () => {
  const enKeys = new Set(flattenKeys(en));
  const heKeys = new Set(flattenKeys(he));
  assert.deepEqual([...enKeys].filter((k) => !heKeys.has(k)), [], 'missing in he.json');
  assert.deepEqual([...heKeys].filter((k) => !enKeys.has(k)), [], 'missing in en.json');
});

test('no message is empty', () => {
  for (const [name, catalog] of [['en', en], ['he', he]] as const) {
    const empty = flattenKeys(catalog).filter((path) => {
      const leaf = path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], catalog);
      return typeof leaf !== 'string' || leaf.trim() === '';
    });
    assert.deepEqual(empty, [], `empty messages in ${name}.json`);
  }
});
