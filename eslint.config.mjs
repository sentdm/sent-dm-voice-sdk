// @ts-check
import tseslint from 'typescript-eslint';
import unusedImports from 'eslint-plugin-unused-imports';

const packageImport = {
  regex: '^@sentdm/voice(/.*)?',
  message: 'Use a relative import, not a package import.',
};

const providerImport = {
  regex: '^sinch-rtc(/.*)?$',
  message: 'sinch-rtc may only be imported by src/adapter/sinch.ts.',
};

export default tseslint.config(
  {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: 'module' },
    },
    files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.cjs'],
    ignores: ['dist/'],
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'unused-imports': unusedImports,
    },
    rules: {
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'no-restricted-imports': ['error', { patterns: [packageImport, providerImport] }],
    },
  },
  {
    files: ['src/adapter/sinch.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [packageImport] }],
    },
  },
  {
    files: ['tests/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
