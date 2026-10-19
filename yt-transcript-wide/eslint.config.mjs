// ESLint flat config. `npm run lint` runs ESLint through npx, so nothing is installed into the
// extension folder (Chrome refuses to load an unpacked extension that contains node_modules).
const readonly = (names) => Object.fromEntries(names.map((n) => [n, 'readonly']));

const browser = readonly([
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'localStorage',
  'indexedDB',
  'performance',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'fetch',
  'URL',
  'Blob',
  'Event',
  'TextEncoder',
  'ResizeObserver',
  'CSS',
  'self',
  'console',
  // Chrome's built-in AI APIs (Chrome 138+), feature-detected before use
  'Translator',
  'LanguageDetector'
]);
const extension = readonly(['chrome']);
// Globals the extension's own scripts publish for each other (classic scripts, no bundler)
const app = readonly(['YTCT', 'YTCTPanel', 'YTCTExport', 'YTCTPdf', 'YTCTSync', 'YTCTTrends', 'YTCTNetwork']);

export default [
  { ignores: ['dist/**', 'vendor/**', 'node_modules/**'] },
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...browser, ...extension, ...app, module: 'readonly' }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-const-assign': 'error',
      'no-func-assign': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }]
    }
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: readonly(['process', 'console', 'URL', 'Buffer', 'structuredClone'])
    },
    rules: { 'no-undef': 'error', 'no-unused-vars': 'warn' }
  }
];
