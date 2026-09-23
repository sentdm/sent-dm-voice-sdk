import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as errors from '@sentdm/voice/errors';

const distDir = path.resolve(__dirname, '..', 'dist');
const entries = ['@sentdm/voice', '@sentdm/voice/errors', '@sentdm/voice/react'];
const formats = ['cjs', 'esm'] as const;
const namespaceTypes = [
  'ConnectParams',
  'JoinConferenceParams',
  'ClientState',
  'CallState',
  'Address',
  'CallStats',
  'DisconnectInfo',
  'QualityWarning',
  'CancelInfo',
  'Call',
  'CallInvite',
];

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

  test.each(formats)('every SentVoice namespace type resolves from the default export as %s', (format) => {
    const file = path.join(distDir, format === 'cjs' ? 'types.cts' : 'types.mts');
    const source = `import SentVoice from '@sentdm/voice';
export type Types = [${namespaceTypes.map((type) => `SentVoice.${type}`).join(', ')}];`;
    const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const host = ts.createCompilerHost(options);
    const { fileExists, readFile } = host;
    host.fileExists = (fileName) => fileName === file || fileExists(fileName);
    host.readFile = (fileName) => (fileName === file ? source : readFile(fileName));

    const messages = ts
      .getPreEmitDiagnostics(ts.createProgram([file], options, host))
      .map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, '\n'));

    expect(messages).toEqual([]);
  });

  test('adapter types are not reachable from any public entry point', () => {
    const { exports } = JSON.parse(fs.readFileSync(path.join(distDir, 'package.json'), 'utf8')) as {
      exports: Record<string, string | { require: { types: string }; types: string }>;
    };
    const declarations = Object.values(exports).flatMap((entry) =>
      typeof entry === 'string' ? [] : [entry.require.types, entry.types],
    );
    const program = ts.createProgram(
      declarations.map((declaration) => path.join(distDir, declaration)),
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
    );
    const reached = program.getSourceFiles().map((file) => path.relative(distDir, file.fileName));

    expect(reached.filter((file) => file.startsWith('adapter/'))).toEqual([]);
  });

  test('the service worker ships as @sentdm/voice/sw.js', () => {
    const worker = runInDist('cjs', `console.log(JSON.stringify(require.resolve('@sentdm/voice/sw.js')));`);

    expect(fs.readFileSync(worker as string, 'utf8')).toBe(
      fs.readFileSync(path.resolve(__dirname, '..', 'src', 'sw.js'), 'utf8'),
    );
  });
});
