const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// allure/writer.js only passes the right options to allure-cypress, so allure-cypress is replaced to see what it's given
const REPORTER = require.resolve('@benchesh/allure-cypress/reporter');
const WRITER = require.resolve('../../allure/writer');

describe('allure/writer', () => {
    let calls;
    let writer;

    beforeEach(() => {
        calls = [];
        require.cache[REPORTER] = { id: REPORTER, filename: REPORTER, loaded: true, exports: { allureCypress: (...args) => calls.push(args) } };
        delete require.cache[WRITER];
        writer = require(WRITER);
    });

    afterEach(() => {
        delete require.cache[REPORTER];
        delete require.cache[WRITER];
    });

    const on = () => { };

    it("writes to the thread's allure results directory by default, not the fallback one", () => {
        const config = { env: { allureResults: '/results/allure-results/3' } };

        writer(on, config);

        assert.equal(calls.length, 1);
        assert.equal(calls[0][0], on);
        assert.equal(calls[0][1], config);
        assert.deepEqual(calls[0][2], { resultsDir: '/results/allure-results/3' });
    });

    it('writes to the fallback directory when useFallbackDir is set', () => {
        writer(on, { env: { allureResults: '/results/allure-results/3' } }, undefined, { useFallbackDir: true });

        assert.deepEqual(calls[0][2], { resultsDir: '/results/allure-results/3_fallback' });
    });

    it('passes the allure config on to allure-cypress', () => {
        const allureConfig = { environmentInfo: { run: 'nightly' }, resultsDir: 'ignored' };

        writer(on, { env: { allureResults: '/results/1' } }, allureConfig);

        assert.deepEqual(calls[0][2], { environmentInfo: { run: 'nightly' }, resultsDir: '/results/1' });
        assert.equal(allureConfig.resultsDir, 'ignored', 'the given config is not changed');
    });

    it("leaves the results directory to allure-cypress when it isn't being run by the runner", () => {
        writer(on, { env: {} }, { resultsDir: 'my-results' });
        writer(on, { env: {} }, undefined, { useFallbackDir: true });

        assert.deepEqual(calls[0][2], { resultsDir: 'my-results' });
        assert.deepEqual(calls[1][2], {});
    });
});
