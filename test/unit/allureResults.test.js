const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { AllureResultsStore, resultFullTitle, testHistoryId } = require('../../lib/allure/results');
const { Thread } = require('../../lib/threads/Thread');
const { createTempDir } = require('../helpers/tempDir');
const { keepDirectory } = require('../helpers/artifacts');

// real result files from @mmisty/cypress-allure-adapter and its allure-cypress fallback
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'allure-results');
const fixtureResults = (dir) => fs.readdirSync(path.join(FIXTURES, dir)).map((file) => fs.readJsonSync(path.join(FIXTURES, dir, file)));

const phase = { phaseNo: 1 };

describe('resultFullTitle', () => {
    it('reads the full test title from both adapters', () => {
        const mmisty = fixtureResults('pass').map(resultFullTitle).sort();
        const fallback = fixtureResults('pass_fallback').map(resultFullTitle).sort();

        assert.deepEqual(mmisty, ['Passing suite nested passes nested', 'Passing suite passes first']);
        assert.deepEqual(fallback, mmisty);
    });

    it('falls back to suite labels and the name', () => {
        assert.equal(resultFullTitle({ name: 'test', labels: [{ name: 'parentSuite', value: 'A' }, { name: 'suite', value: 'B' }] }), 'A B test');
    });

    it('keeps "#" characters in titles from adapters that do not prefix the spec path', () => {
        assert.equal(resultFullTitle({ fullName: 'Suite handles issue #12' }), 'Suite handles issue #12');
    });
});

describe('AllureResultsStore', () => {
    let temp;
    let store;
    let thread;

    const copyFixture = (fixtureDir, targetDir) => fs.copySync(path.join(FIXTURES, fixtureDir), path.join(temp.dir, 'allure-results', targetDir));
    const rootResults = () => fs.readdirSync(path.join(temp.dir, 'allure-results'))
        .filter((file) => file.endsWith('-result.json'))
        .map((file) => fs.readJsonSync(path.join(temp.dir, 'allure-results', file)));

    beforeEach(() => {
        temp = createTempDir();
        store = new AllureResultsStore({ allureResultsDir: path.join(temp.dir, 'allure-results'), cwd: temp.dir });
        thread = new Thread({ threadNo: 1, phase, spec: path.join(temp.dir, 'cypress/e2e/flaky.cy.js') });
    });

    afterEach((t) => {
        // the Allure results directory as it was left by the test
        keepDirectory({ kind: 'unit', suite: 'allure-results-store', name: t.name }, temp.dir);
        temp.cleanup();
    });

    it('collects results into the root directory, recording each one on the thread', () => {
        copyFixture('flaky', '1');
        copyFixture('flaky_fallback', '1_fallback');

        store.collect(thread);

        assert.equal(thread.hasResults, true);
        assert.deepEqual(thread.results.map((r) => [r.fullTitle, r.status, r.attempt]).sort(), [
            ['Flaky suite passes on the second attempt', 'failed', 1],
            ['Flaky suite passes on the second attempt', 'passed', 1],
        ]);
        assert.equal(rootResults().length, 2);
        assert.equal(fs.existsSync(path.join(temp.dir, 'allure-results', '1')), false);
        assert.equal(fs.existsSync(path.join(temp.dir, 'allure-results', '1_fallback')), false);
    });

    it('uses the fallback results when the main adapter produced none', () => {
        copyFixture('flaky_fallback', '1_fallback');

        store.collect(thread);

        assert.deepEqual(thread.results.map((r) => r.status), ['passed']);
    });

    it('gives each test a stable history id based on the spec path and title, whichever adapter produced it', () => {
        copyFixture('flaky', '1');
        store.collect(thread);

        const mmistyIds = new Set(rootResults().map((r) => r.historyId));

        fs.emptyDirSync(path.join(temp.dir, 'allure-results'));
        copyFixture('flaky_fallback', '1_fallback');
        store.collect(thread);

        const expected = testHistoryId('cypress/e2e/flaky.cy.js', 'Flaky suite passes on the second attempt');

        assert.deepEqual([...mmistyIds], [expected]);
        assert.deepEqual(rootResults().map((r) => r.historyId), [expected]);
    });

    it('nudges timestamps by status so retries display correctly', () => {
        copyFixture('flaky', '1');
        const original = fixtureResults('flaky').find((r) => r.status === 'passed');

        store.collect(thread);

        assert.equal(rootResults().find((r) => r.status === 'passed').start, original.start + 3);
    });

    it('records which attempt each result came from', () => {
        copyFixture('flaky', '1');
        store.collect(thread);

        thread.prepareRetry('retry');
        copyFixture('flaky_fallback', '1_fallback');
        store.collect(thread);

        assert.deepEqual(thread.results.map((r) => r.attempt).sort(), [1, 1, 2]);
    });

    it('detects crash messages within result files', () => {
        copyFixture('hook-crash', '1');
        assert.match(store.findCrashLogs(thread), /1[/\\][^/\\]+-result\.json$/);

        store.clear(thread);
        copyFixture('flaky', '1');
        assert.equal(store.findCrashLogs(thread), null);
    });

    it('writes results for tests that did not produce one', () => {
        const test = { titlePath: ['Suite', 'Nested', 'Deeper', 'Deepest'], title: 'missing', fullTitle: 'Suite Nested Deeper Deepest missing', tags: ['@smoke'] };

        store.writeSyntheticResult({ spec: thread.spec, test, status: 'broken', message: 'why', time: 1000 });

        const [result] = rootResults();

        assert.equal(result.status, 'broken');
        assert.equal(result.name, 'missing');
        assert.equal(result.fullName, test.fullTitle);
        assert.equal(result.historyId, testHistoryId('cypress/e2e/flaky.cy.js', test.fullTitle));
        assert.deepEqual(result.statusDetails, { message: 'why' });
        assert.deepEqual(result.labels, [
            { name: 'package', value: 'cypress.e2e.flaky.cy.js' },
            { name: 'path', value: 'cypress/e2e/flaky.cy.js' },
            { name: 'parentSuite', value: 'Suite' },
            { name: 'suite', value: 'Nested' },
            { name: 'subSuite', value: 'Deeper' },
            { name: 'tag', value: '@smoke' },
        ]);
        assert.equal(result.start, 1000);
    });
});
