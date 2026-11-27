// Run with `npm run lint`. It's also part of the unit tests (see test/unit/lint.test.js), so `npm test` fails on any
// lint error or warning

const js = require('@eslint/js');
const globals = require('globals');

// Cypress's globals, which are available to the fixture project's specs. (Mocha's describe, it, before etc. are in globals.mocha)
const cypressGlobals = {
    cy: 'readonly',
    Cypress: 'readonly',
    expect: 'readonly',
    assert: 'readonly',
};

module.exports = [
    { ignores: ['test-artifacts/'] },

    js.configs.recommended,

    {
        // the runner, its tests and the fixture project's Cypress config are CommonJS, and run in Node
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: globals.node,
        },
        rules: {
            'no-var': 'error',
            'prefer-const': 'error',
            eqeqeq: ['error', 'always', { null: 'ignore' }],
        },
    },

    {
        // runs inside the generated Allure report, so it's a browser script rather than a Node module
        files: ['lib/allure/html/client.js'],
        languageOptions: {
            sourceType: 'script',
            globals: globals.browser,
        },
    },

    {
        // Cypress bundles these as ES modules, and runs them in the browser
        files: ['allure.js', 'test/fixtures/cypress-project/cypress/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.mocha, ...cypressGlobals },
        },
    },
];
