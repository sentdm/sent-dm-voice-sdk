import { execFileSync } from 'node:child_process';
import path from 'node:path';
import * as errors from '@sentdm/voice/errors';

const distDir = path.resolve(__dirname, '..', 'dist');
const entries = ['@sentdm/voice', '@sentdm/voice/errors', '@sentdm/voice/react'];
const formats = ['cjs', 'esm'] as const;

const runInDist = (format: (typeof formats)[number], body: string): unknown => {
  const load =
    format === 'cjs' ? 'async (specifier) => require(specifier)' : '(specifier) => import(specifier)';
  const script = `const load = ${load};
(async () => {
${body}
})().catch((error) => {
  console.error(error);
  process.exit(1);
});`;
  const args = format === 'cjs' ? ['-e', script] : ['--input-type=module', '-e', script];
  return JSON.parse(execFileSync(process.execPath, args, { cwd: distDir, encoding: 'utf8' }));
};

describe('built package', () => {
  test.each(formats)('every entry loads as %s without touching window, document or navigator', (format) => {
    const touched = runInDist(
      format,
      `const touched = [];
for (const name of ['window', 'document', 'navigator']) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: () => {
      touched.push(name);
      return undefined;
    },
  });
}
for (const entry of ${JSON.stringify(entries)}) await load(entry);
console.log(JSON.stringify(touched));`,
    );

    expect(touched).toEqual([]);
  });

  test.each(formats)(
    'every error subclass is instanceof itself, SentVoiceError and Error as %s',
    (format) => {
      const result = runInDist(
        format,
        `const { SentVoiceError, ...subclasses } = await load('@sentdm/voice/errors');
const result = {};
for (const [name, ErrorClass] of Object.entries(subclasses)) {
  const error = new ErrorClass();
  result[name] = error instanceof ErrorClass && error instanceof SentVoiceError && error instanceof Error;
}
console.log(JSON.stringify(result));`,
      );
      const subclassNames = Object.keys(errors).filter((name) => name !== 'SentVoiceError');

      expect(result).toEqual(Object.fromEntries(subclassNames.map((name) => [name, true])));
    },
  );
});
