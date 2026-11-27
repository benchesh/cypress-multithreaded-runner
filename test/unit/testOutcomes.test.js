const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { resolveThreadOutcomes, assumedPassedOutcomes, computeTestStats, hasFailures } = require('../../lib/report/testOutcomes');
const { Thread, Outcome } = require('../../lib/threads/Thread');
const { normaliseSettings } = require('../../lib/config/settings');

const settings = normaliseSettings({});

const discovered = (fullTitle, overrides = {}) => ({
    titlePath: fullTitle.split(' ').slice(0, -1),
    title: fullTitle.split(' ').pop(),
    fullTitle,
    tags: [],
    pending: false,
    grepIncluded: true,
    ...overrides,
});

const createThread = (outcome, results = []) => {
    const thread = new Thread({ threadNo: 1, phase: { phaseNo: 1 }, spec: 'a.cy.js' });
    thread.outcome = outcome;
    thread.results = results.map(([fullTitle, status, attempt = 1, start = 0]) => ({ fullTitle, status, attempt, start }));
    return thread;
};

const discovery = (tests, estimated = false) => ({ spec: 'a.cy.js', tests, estimated, error: null });

describe('resolveThreadOutcomes', () => {
    it('uses the latest result of each test and counts failed attempts', () => {
        const thread = createThread(Outcome.PASSED, [
            ['S flaky', 'failed', 1, 10],
            ['S flaky', 'passed', 1, 20],
            ['S stable', 'passed', 1, 5],
        ]);

        const { tests, missing } = resolveThreadOutcomes(thread, discovery([discovered('S flaky'), discovered('S stable')]), settings);

        assert.deepEqual(tests.map((t) => [t.fullTitle, t.status, t.failedAttempts, t.origin]), [
            ['S flaky', 'passed', 1, 'result'],
            ['S stable', 'passed', 0, 'result'],
        ]);
        assert.deepEqual(missing, []);
    });

    it('prefers results from later attempts (retryAllFailedSpecs)', () => {
        const thread = createThread(Outcome.PASSED, [
            ['S test', 'failed', 1, 100],
            ['S test', 'passed', 2, 50],
        ]);

        thread.attempts = 2;

        const { tests } = resolveThreadOutcomes(thread, discovery([discovered('S test')]), settings);

        assert.deepEqual(tests.map((t) => [t.status, t.failedAttempts]), [['passed', 1]]);
    });

    it('counts failed results separately for each attempt of the thread (retryAllFailedSpecs)', () => {
        const thread = createThread(Outcome.FAILED, [
            ['S flaky', 'failed', 1, 1],
            ['S flaky', 'failed', 1, 2],
            ['S flaky', 'passed', 1, 3],
            ['S broken', 'broken', 1, 4],
            ['S flaky', 'failed', 3, 5],
            ['S flaky', 'passed', 3, 6],
            ['S broken', 'broken', 3, 7],
        ]);
        thread.attempts = 3; // the 2nd attempt didn't produce any results (e.g. its phase was stopped)

        const { tests } = resolveThreadOutcomes(thread, discovery([discovered('S flaky'), discovered('S broken')]), settings);

        assert.deepEqual(tests.map((t) => [t.fullTitle, t.failedAttempts, t.failedAttemptsByThreadAttempt]), [
            ['S flaky', 3, [2, 0, 1]],
            ['S broken', 2, [1, 0, 1]],
        ]);
    });

    it('fills in tests that did not produce a result when the thread crashed or timed out', () => {
        [Outcome.CRASHED, Outcome.TIMED_OUT, Outcome.ABORTED].forEach((outcome) => {
            const thread = createThread(outcome, [['S first', 'passed']]);

            const { tests, missing } = resolveThreadOutcomes(thread, discovery([
                discovered('S first'),
                discovered('S second'),
                discovered('S pending', { pending: true }),
                discovered('S not grepped', { grepIncluded: false }),
            ]), settings);

            assert.deepEqual(missing.map((m) => [m.test.fullTitle, m.status]), [['S second', 'broken'], ['S pending', 'skipped']], outcome);
            assert.match(missing[0].message, /Added by Cypress Multithreaded Runner/);
            assert.deepEqual(tests.map((t) => [t.fullTitle, t.status, t.origin, Boolean(t.notRun)]), [
                ['S first', 'passed', 'result', false],
                ['S second', 'broken', 'filled', false],
                ['S pending', 'skipped', 'filled', false],
            ], outcome);
        });
    });

    it('fills in tests from stopped phases as failed, flagging them as not run (but leaving pending tests skipped)', () => {
        [Outcome.STOPPED, Outcome.NOT_RUN].forEach((outcome) => {
            const { tests, missing } = resolveThreadOutcomes(createThread(outcome), discovery([
                discovered('S test'),
                discovered('S pending', { pending: true }),
            ]), settings);

            assert.deepEqual(missing.map((m) => m.status), ['failed', 'skipped']);
            assert.match(missing[0].message, /This test didn't run because a thread in an earlier phase failed, so threads in subsequent phases were stopped/);
            assert.deepEqual(tests.map((t) => [t.status, Boolean(t.notRun)]), [['failed', true], ['skipped', false]]);
        });
    });

    it('does not fill in tests for threads that finished normally, but reports them as unaccounted', () => {
        const { tests, missing, unaccounted } = resolveThreadOutcomes(createThread(Outcome.FAILED, [['S a', 'failed']]), discovery([discovered('S a'), discovered('S b')]), settings);

        assert.deepEqual(missing, []);
        assert.deepEqual(unaccounted.map((t) => t.fullTitle), ['S b']);
        assert.equal(tests.length, 1);
    });

    it('matches estimated discoveries by title alone', () => {
        const thread = createThread(Outcome.CRASHED, [['Some Suite first', 'passed']]);
        const estimated = discovery([
            { titlePath: [], title: 'first', fullTitle: 'first', tags: [], pending: false, grepIncluded: true },
            { titlePath: [], title: 'second', fullTitle: 'second', tags: [], pending: false, grepIncluded: true },
        ], true);

        assert.deepEqual(resolveThreadOutcomes(thread, estimated, settings).missing.map((m) => m.test.title), ['second']);
    });
});

describe('assumedPassedOutcomes', () => {
    it('records every grep-included test as passed, except pending tests, which are skipped', () => {
        const outcomes = assumedPassedOutcomes(discovery([
            discovered('S a'),
            discovered('S b', { pending: true }),
            discovered('S c', { grepIncluded: false }),
        ]));

        assert.deepEqual(outcomes.map((o) => [o.fullTitle, o.status, o.origin, o.assumedPassed]), [
            ['S a', 'passed', 'assumed', true],
            ['S b', 'skipped', 'assumed', false],
        ]);
    });
});

describe('computeTestStats', () => {
    const outcome = (status, extra = {}) => ({ fullTitle: 'x', status, failedAttempts: 0, origin: 'result', ...extra });

    it('calculates the success percentage from tests, excluding intentionally skipped tests', () => {
        const stats = computeTestStats([
            outcome('passed'),
            outcome('passed'),
            outcome('passed', { origin: 'assumed', assumedPassed: true }),
            outcome('skipped', { origin: 'assumed', assumedPassed: false }),
            outcome('failed'),
            outcome('broken', { origin: 'filled' }),
            outcome('skipped'),
            outcome('failed', { notRun: true, origin: 'filled' }),
        ]);

        assert.deepEqual(stats, {
            total: 8,
            passed: 3,
            failed: 2,
            broken: 1,
            skipped: 2,
            unknown: 0,
            notRun: 1,
            filledIn: 2,
            assumedPassed: 1,
            // 3 passed of 6 (8 tests minus 2 skipped). The test assumed to have passed previously counts as passed
            successPercentage: 50,
        });
    });

    it('rounds to two decimal places and handles no tests', () => {
        assert.equal(computeTestStats([outcome('passed'), outcome('passed'), outcome('failed')]).successPercentage, 66.67);
        assert.equal(computeTestStats([]).successPercentage, 0);
    });

    it('hasFailures', () => {
        assert.equal(hasFailures([outcome('passed'), outcome('skipped')]), false);
        assert.equal(hasFailures([outcome('unknown')]), true);
        assert.equal(hasFailures([outcome('failed', { notRun: true })]), true);
    });
});
