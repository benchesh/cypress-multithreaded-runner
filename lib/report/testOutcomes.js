// Works out the final outcome of every test, combining real Allure results with the tests discovered up
// front, so that tests which never produced a result are still accounted for

const { Outcome, INCOMPLETE_OUTCOMES } = require('../threads/Thread');
const { secondsToNaturalString, pluralise } = require('../util/format');

const FAILED_STATUSES = ['failed', 'broken'];

/**
 * @typedef {object} TestOutcome
 * @property {string} fullTitle
 * @property {string} status passed, failed, broken, skipped or unknown
 * @property {number} failedAttempts how many results for this test failed (across retries and attempts)
 * @property {number[]} failedAttemptsByThreadAttempt the same, for each attempt of the thread (see
 * retryAllFailedSpecs). Index 0 is the first attempt
 * @property {'result'|'filled'|'assumed'} origin where the outcome came from: a real Allure result, a result
 * filled in because the thread didn't finish, or a result assumed because the spec wasn't re-run
 * @property {boolean} [notRun] a test that was meant to run but didn't, because a thread in an earlier phase
 * failed. It's recorded as failed
 * @property {boolean} [assumedPassed] a test in a spec file that wasn't run because it passed previously. It's
 * recorded as passed
 */

const matchesTest = (test, fullTitle, estimated) => fullTitle === test.fullTitle
    || (estimated && (fullTitle === test.title || fullTitle.endsWith(` ${test.title}`)));

/**
 * The reason a filled-in result gives for the missing test
 */
const missingResultMessage = (thread, settings) => {
    switch (thread.outcome) {
        case Outcome.CRASHED:
            return `This test didn't produce a result because Cypress crashed in thread #${thread.threadNo} and ran out of restarts (maxThreadRestarts: ${settings.maxThreadRestarts}). Added by Cypress Multithreaded Runner.`;
        case Outcome.TIMED_OUT:
            return `This test didn't produce a result because thread #${thread.threadNo} went over the time limit of ${secondsToNaturalString(settings.threadTimeLimit)} and was stopped. Added by Cypress Multithreaded Runner.`;
        case Outcome.ABORTED:
            return `This test didn't produce a result because more than ${pluralise(settings.maxAllowedTimeouts, 'thread')} timed out, so every thread was stopped. Added by Cypress Multithreaded Runner.`;
        default:
            return 'This test didn\'t run because a thread in an earlier phase failed, so threads in subsequent phases were stopped (stopSubsequentPhasesOnFail). Added by Cypress Multithreaded Runner.';
    }
};

/**
 * Resolve the outcome of every test in one thread
 *
 * @param {import('../threads/Thread').Thread} thread
 * @param {import('../discovery/discoverTests').SpecDiscovery|undefined} discovery
 * @param {object} settings
 * @returns {{tests: TestOutcome[], missing: Array<{test: object, status: string, message: string}>, unaccounted: object[]}}
 * `missing`: discovered tests that need a filled-in result. `unaccounted`: discovered tests with no result
 * in a thread that finished normally (most likely a test whose title is only known at runtime)
 */
const resolveThreadOutcomes = (thread, discovery, settings) => {
    const latest = new Map();
    /** fullTitle => the number of failed results in each attempt of the thread */
    const failedAttempts = new Map();
    const noFailures = () => Array(thread.attempts).fill(0);

    thread.results.forEach((result) => {
        const previous = latest.get(result.fullTitle);

        if (!previous || result.attempt > previous.attempt || (result.attempt === previous.attempt && result.start >= previous.start)) {
            latest.set(result.fullTitle, result);
        }

        if (FAILED_STATUSES.includes(result.status)) {
            const counts = failedAttempts.get(result.fullTitle) || noFailures();
            const index = (result.attempt || 1) - 1;
            counts[index] = (counts[index] || 0) + 1;
            failedAttempts.set(result.fullTitle, counts);
        }
    });

    const tests = [...latest.values()].map((result) => {
        const byThreadAttempt = failedAttempts.get(result.fullTitle) || noFailures();

        return {
            fullTitle: result.fullTitle,
            status: result.status,
            failedAttempts: byThreadAttempt.reduce((total, count) => total + count, 0),
            failedAttemptsByThreadAttempt: byThreadAttempt,
            origin: 'result',
        };
    });

    const resultTitles = [...latest.keys()];
    const withoutResults = (discovery?.tests || [])
        .filter((test) => test.grepIncluded)
        .filter((test) => !resultTitles.some((fullTitle) => matchesTest(test, fullTitle, discovery.estimated)));

    const fillStatus = INCOMPLETE_OUTCOMES[thread.outcome];

    if (!fillStatus) {
        return { tests, missing: [], unaccounted: withoutResults };
    }

    const message = missingResultMessage(thread, settings);

    const missing = withoutResults.map((test) => ({
        test,
        status: test.pending ? 'skipped' : fillStatus,
        message: test.pending ? `This test is pending. ${message}` : message,
    }));

    missing.forEach(({ test, status }) => tests.push({
        fullTitle: test.fullTitle,
        status,
        failedAttempts: 0,
        failedAttemptsByThreadAttempt: noFailures(),
        origin: 'filled',
        notRun: !test.pending && [Outcome.STOPPED, Outcome.NOT_RUN].includes(thread.outcome),
    }));

    return { tests, missing, unaccounted: [] };
};

/**
 * Outcomes for the tests in spec files that weren't run because they passed previously. They're recorded as
 * passed, so they count towards the success percentage, except for tests that are skipped anyway (e.g. `it.skip`)
 */
const assumedPassedOutcomes = (discovery) => discovery.tests
    .filter((test) => test.grepIncluded)
    .map((test) => ({
        test,
        fullTitle: test.fullTitle,
        status: test.pending ? 'skipped' : 'passed',
        assumedPassed: !test.pending,
        failedAttempts: 0,
        origin: 'assumed',
    }));

/**
 * @param {TestOutcome[]} outcomes
 * @returns {{total: number, passed: number, failed: number, broken: number, skipped: number, unknown: number,
 * notRun: number, filledIn: number, assumedPassed: number, successPercentage: number}}
 * successPercentage = passed / (total - skipped tests). Tests that were meant to run but didn't (e.g. their
 * phase was stopped) are failed tests, so count against the percentage. `notRun` is only informational.
 * `assumedPassed` is how many of the passed tests are in spec files that weren't run because they passed previously
 */
const computeTestStats = (outcomes) => {
    const stats = {
        total: outcomes.length,
        passed: 0,
        failed: 0,
        broken: 0,
        skipped: 0,
        unknown: 0,
        notRun: 0,
        filledIn: 0,
        assumedPassed: 0,
    };

    outcomes.forEach((outcome) => {
        const status = ['passed', 'failed', 'broken', 'skipped'].includes(outcome.status) ? outcome.status : 'unknown';
        stats[status]++;

        if (outcome.notRun) stats.notRun++;
        if (outcome.origin === 'filled') stats.filledIn++;
        if (outcome.origin === 'assumed' && outcome.assumedPassed) stats.assumedPassed++;
    });

    const denominator = stats.total - stats.skipped;

    stats.successPercentage = denominator > 0
        ? Math.round((stats.passed / denominator) * 10000) / 100
        : 0;

    return stats;
};

const hasFailures = (outcomes) => outcomes.some((outcome) => ['failed', 'broken', 'unknown'].includes(outcome.status));

module.exports = {
    resolveThreadOutcomes,
    assumedPassedOutcomes,
    computeTestStats,
    hasFailures,
    matchesTest,
};
