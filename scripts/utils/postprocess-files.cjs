// @ts-check
const fs = require('fs');
const path = require('path');

const distDir =
  process.env['DIST_PATH'] ?
    path.resolve(process.env['DIST_PATH'])
  : path.resolve(__dirname, '..', '..', 'dist');

async function* walk(dir) {
  for await (const d of await fs.promises.opendir(dir)) {
    const entry = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(entry);
    else if (d.isFile()) yield entry;
  }
}

async function postprocess() {
  for await (const file of walk(distDir)) {
    if (!/(\.d)?[cm]?ts$/.test(file)) continue;

    const code = await fs.promises.readFile(file, 'utf8');

    // strip out lib="dom", types="node", and types="react" references; these
    // are needed at build time, but would pollute the user's TS environment
    let transformed = code.replace(
      /^ *\/\/\/ *<reference +(lib="dom"|types="(node|react)").*?\n/gm,
      // replace with same number of characters to avoid breaking source maps
      (match) => ' '.repeat(match.length - 1) + '\n',
    );

    // TypeScript's declaration emitter collapses /** @ts-ignore */ onto the same
    // line as the type declaration, which doesn't work. So we convert to // @ts-ignore
    // on its own line to properly suppresses errors.
    if (file.endsWith('.d.ts') || file.endsWith('.d.mts') || file.endsWith('.d.cts')) {
      transformed = transformed.replace(/\/\*\* @ts-ignore\b[^*]*\*\/ /gm, '// @ts-ignore\n');
    }

    if (transformed !== code) {
      console.error(`wrote ${path.relative(process.cwd(), file)}`);
      await fs.promises.writeFile(file, transformed, 'utf8');
    }
  }
}
postprocess();
