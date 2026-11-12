/**
 * Test helper: loads the Core module of /legacy/shopify-shipping-converter.html
 * in Node (it exports itself via module.exports). Used only by the parity tests.
 *
 * The legacy module keeps some functions private (readFile, validateOrder,
 * phoneMatchKey, ...). To compare them directly, the loader adds them to the
 * returned object in memory. The legacy file on disk is never changed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const LEGACY_PATH = fileURLToPath(
  new URL('../../../legacy/shopify-shipping-converter.html', import.meta.url),
);

const EXTRA_EXPORTS =
  'readFile: readFile, validateOrder: validateOrder, phoneMatchKey: phoneMatchKey, ' +
  'phoneProblem: phoneProblem, productsKey: productsKey, recipientKey: recipientKey, ' +
  'hashBytes: hashBytes, exportRows: exportRows, zip: zip, ';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LegacyCore = any;

export function loadLegacyCore(): LegacyCore {
  const html = readFileSync(LEGACY_PATH, 'utf8');
  const start = html.indexOf('/*CORE-START*/');
  const end = html.indexOf('/*CORE-END*/');
  if (start < 0 || end < start) throw new Error('Legacy core markers not found');
  let source = html.slice(start, end);
  const anchor = 'return { OUTPUT: OUTPUT,';
  if (!source.includes(anchor)) throw new Error('Legacy core export object not found');
  source = source.replace(anchor, 'return { ' + EXTRA_EXPORTS + 'OUTPUT: OUTPUT,');
  // TextDecoder / TextEncoder are not ECMAScript built-ins, so a fresh context lacks them.
  const sandbox = { module: { exports: {} as unknown }, TextDecoder, TextEncoder };
  vm.runInNewContext(source, sandbox, { filename: 'shopify-shipping-converter.html#core' });
  return sandbox.module.exports;
}
