// Lint is part of the unit tests, so `npm test` fails on any lint error or warning. See eslint.config.js,
// and run `npm run lint` to check without running the tests

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { ESLint } = require('eslint');

const ROOT = path.join(__dirname, '..', '..');

describe('eslint', () => {
    let eslint;
    let results;

    before(async () => {
        eslint = new ESLint({ cwd: ROOT });
        results = await eslint.lintFiles(['.']);
    });

    it('finds no errors or warnings', async () => {
        const problems = results.filter((result) => result.errorCount + result.warningCount > 0);
        const formatter = await eslint.loadFormatter('stylish');

        assert.equal(problems.length, 0, `\n${await formatter.format(problems)}`);
    });

    it('lints the source, tests, fixtures and config, so a mistake in the config can\'t make this pass by linting nothing', () => {
        const linted = results.map((result) => path.relative(ROOT, result.filePath).split(path.sep).join('/'));

        [
            'index.js',
            'allure.js',
            'allure/writer.js',
            'eslint.config.js',
            'lib/run.js',
            'lib/allure/html/client.js',
            'test/unit/lint.test.js',
            'test/integration/runner.test.js',
            'test/fixtures/cypress-project/cypress.config.js',
            'test/fixtures/cypress-project/cypress/e2e/mixed/broken.cy.js',
            'test/fixtures/cypress-project/cypress/support/runCount.js',
        ].forEach((file) => assert.ok(linted.includes(file), `${file} wasn't linted`));

        // generated output isn't ours to lint
        assert.deepEqual(linted.filter((file) => file.startsWith('test-artifacts/') || file.startsWith('node_modules/')), []);
    });
});
