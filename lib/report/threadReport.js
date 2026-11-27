// Builds the thread performance report: a status for each thread, the per-thread headings and summaries
// shown in the Allure report, and the text summary/percentage bars written to the console and text files

const { Outcome } = require('../threads/Thread');
const {
    arrToNaturalStr,
    generatePercentageBar,
    ordinal,
    pluralise,
    secondsToNaturalString,
    shortenPath,
} = require('../util/format');

const FAILING_STATUSES = ['failed', 'broken', 'unknown'];

const OUTCOME_ERRORS = {
    [Outcome.NO_SPECS]: () => 'ERROR: No spec files found!',
    [Outcome.CRASHED]: () => 'CRITICAL ERROR: Thread did not complete!',
    [Outcome.ABORTED]: () => 'CRITICAL ERROR: Thread did not complete!',
    [Outcome.TIMED_OUT]: (settings) => `CRITICAL ERROR: Thread did not complete as it went over the time limit of ${secondsToNaturalString(settings.threadTimeLimit)}`,
    [Outcome.STOPPED]: () => 'ERROR: Thread was stopped because a thread in an earlier phase failed',
    [Outcome.NOT_RUN]: () => 'ERROR: Thread did not run because a thread in an earlier phase failed',
};

/**
 * "2 tests failed 1 time" etc., from a list of failed attempt counts
 */
const describeFailCounts = (failedAttemptCounts) => {
    const counts = {};

    failedAttemptCounts.filter((n) => n > 0).forEach((n) => {
        counts[n] = (counts[n] || 0) + 1;
    });

    return Object.keys(counts)
        .map(Number)
        .sort((a, b) => b - a)
        .map((n) => `${pluralise(counts[n], 'test')} failed ${pluralise(n, 'time')}`);
};

/**
 * How an attempt of a thread ended, for threads that were retried (see retryAllFailedSpecs). A crash is described by
 * its restarts instead
 */
const ATTEMPT_OUTCOMES = {
    [Outcome.PASSED]: () => 'the spec file passed',
    [Outcome.FAILED]: () => 'the spec file failed',
    [Outcome.TIMED_OUT]: (settings) => `the thread went over the time limit of ${secondsToNaturalString(settings.threadTimeLimit)}`,
    [Outcome.ABORTED]: () => 'the thread was stopped because too many threads timed out',
    [Outcome.STOPPED]: () => 'the thread was stopped because a thread in an earlier phase failed',
    [Outcome.NOT_RUN]: () => 'the thread didn\'t run because a thread in an earlier phase failed',
};

const describeRestarts = (restarts, outcome) => {
    if (!restarts) {
        return null;
    }

    return outcome === Outcome.CRASHED
        ? `the thread crashed ${pluralise(restarts, 'time')}, never recovering`
        : `the thread needed restarting ${pluralise(restarts, 'time')}`;
};

/**
 * What happened in each attempt of a thread that was retried (see retryAllFailedSpecs), keeping the attempts
 * separate, e.g. "In the first attempt: 1 test failed 4 times and the spec file failed. In the second
 * attempt: the spec file passed"
 */
const describeAttempts = (thread, outcomes, settings) => thread.attemptHistory
    .map(({ outcome, restarts }, index) => {
        const details = [
            ...describeFailCounts(outcomes.tests.map((test) => test.failedAttemptsByThreadAttempt?.[index] || 0)),
            describeRestarts(restarts, outcome),
            ATTEMPT_OUTCOMES[outcome]?.(settings),
        ];

        return `In the ${ordinal(index + 1)} attempt: ${arrToNaturalStr(details, { capitalise: false })}`;
    })
    .join('. ');

/**
 * @param {import('../threads/Thread').Thread} thread
 * @param {{tests: object[]}} outcomes the thread's test outcomes
 * @returns {'success'|'warn'|'error'}
 */
const threadStatus = (thread, outcomes) => {
    if (thread.outcome !== Outcome.PASSED || !thread.hasResults) {
        return 'error';
    }

    if (outcomes.tests.some((test) => FAILING_STATUSES.includes(test.status))) {
        return 'error';
    }

    if (thread.restarts || thread.attempts > 1 || outcomes.tests.some((test) => test.failedAttempts)) {
        return 'warn';
    }

    return 'success';
};

/**
 * The warning about a thread (an empty string if there's nothing to warn about), e.g. "2 tests failed 1
 * time and the thread needed restarting 1 time". For a thread that was retried, each attempt is described separately
 */
const threadWarning = (thread, outcomes, settings) => {
    const filled = outcomes.tests.filter((test) => test.origin === 'filled' && test.status === 'broken').length;
    const notRun = outcomes.tests.filter((test) => test.notRun).length;

    // about the outcome of the thread as a whole, rather than any one attempt
    const notes = [
        filled ? `${pluralise(filled, 'test')} didn't produce a result, so ${filled === 1 ? 'it has' : 'they have'} been added to the Allure report as broken` : null,
        notRun ? `${pluralise(notRun, 'test')} didn't run, so ${notRun === 1 ? 'it has' : 'they have'} been added to the Allure report as failed` : null,
        outcomes.unaccounted?.length ? `${pluralise(outcomes.unaccounted.length, 'test')} found in the spec file didn't produce a result (${outcomes.unaccounted.map((test) => `"${test.fullTitle}"`).join(', ')})` : null,
    ];

    if (thread.attempts > 1) {
        return [describeAttempts(thread, outcomes, settings), arrToNaturalStr(notes)].filter(Boolean).join('. ');
    }

    const warnings = [
        ...describeFailCounts(outcomes.tests.map((test) => test.failedAttempts)),
        describeRestarts(thread.restarts, thread.outcome),
        ...notes,
    ].filter(Boolean);

    if (!warnings.length && thread.outcome === Outcome.PASSED && !thread.hasResults) {
        return 'Test results are missing!';
    }

    return arrToNaturalStr(warnings);
};

/**
 * @param {object} options
 * @param {import('../threads/Thread').Thread[]} options.threads
 * @param {Map<number, object>} options.threadOutcomes threadNo => resolveThreadOutcomes() result
 * @param {object} options.settings
 * @param {(phaseNo: number) => boolean} options.isPhaseSkipped whether the user chose to skip a phase
 * @param {object} options.testStats see computeTestStats
 * @param {number} options.assumedPassedSpecCount
 * @returns {{entries: Map<number, object>, summary: string, reportText: string}}
 */
const buildThreadReport = ({ threads, threadOutcomes, settings, isPhaseSkipped, testStats, assumedPassedSpecCount = 0 }) => {
    const entries = new Map();
    const counts = { noSpecs: 0, criticals: 0, timeouts: 0, missingResults: 0, retriedAfterFailing: 0, retriedAfterStopping: 0, stopped: 0 };
    const crashes = {};
    const allFailedAttempts = [];

    const longest = threads.reduce((acc, thread) => (thread.secs > (acc?.secs ?? -1) ? thread : acc), null);
    const idWidth = threads.length > 9 ? 2 : 1;

    let bars = '';

    settings.phases.forEach((phase) => {
        bars += `${phase.title}\n\n`;

        const phaseThreads = threads.filter((thread) => thread.phaseNo === phase.phaseNo);

        if (isPhaseSkipped(phase.phaseNo)) {
            bars += 'Phase skipped!\n\n';
        } else if (!phaseThreads.length) {
            bars += 'No spec files were found!\n\n';
        }

        phaseThreads.forEach((thread) => {
            const outcomes = threadOutcomes.get(thread.threadNo) || { tests: [], unaccounted: [] };
            const id = String(thread.threadNo).padStart(idWidth, '0');
            const status = threadStatus(thread, outcomes);
            const warning = threadWarning(thread, outcomes, settings);
            const attemptsNote = thread.attempts > 1 ? ` (${thread.attempts} attempts)` : '';
            const heading = [`Thread #${id} [${shortenPath(thread.spec)}]${attemptsNote}`];

            let summary = null;

            bars += `Thread #${id} [${thread.spec}]${attemptsNote}\n`;

            const error = OUTCOME_ERRORS[thread.outcome]?.(settings);

            if (error) {
                heading.push(error);
                bars += `${error}\n`;
            }

            switch (thread.outcome) {
                case Outcome.NO_SPECS:
                    counts.noSpecs++;
                    summary = `ERROR: No spec files were found for thread #${id} [${shortenPath(thread.spec)}]`;
                    break;
                case Outcome.CRASHED:
                case Outcome.ABORTED:
                    counts.criticals++;
                    break;
                case Outcome.TIMED_OUT:
                    counts.timeouts++;
                    break;
                case Outcome.STOPPED:
                case Outcome.NOT_RUN:
                    counts.stopped++;
                    break;
                default:
                    break;
            }

            if (thread.restarts) {
                crashes[thread.restarts] = (crashes[thread.restarts] || 0) + 1;
            }

            if (thread.retryReasons.failed) {
                counts.retriedAfterFailing++;
            }

            if (thread.retryReasons.stopped) {
                counts.retriedAfterStopping++;
            }

            if (thread.outcome === Outcome.PASSED && !thread.hasResults) {
                counts.missingResults++;
            }

            allFailedAttempts.push(...outcomes.tests.map((test) => test.failedAttempts));

            if (warning) {
                heading.push(`WARNING: ${warning}`);
                summary = summary || `${status === 'error' ? 'ERROR' : 'WARNING'}: Thread #${id} [${shortenPath(thread.spec)}]: ${warning}`;
            }

            entries.set(thread.threadNo, { status, heading, summary });

            if (thread.secs === undefined || !longest) {
                bars += '\n';
                return;
            }

            const percentage = longest.secs ? (thread.secs / longest.secs) * 100 : 100;
            bars += `${generatePercentageBar(percentage, thread.secs)}${warning ? ` (WARNING: ${warning})` : ''}\n\n`;
        });
    });

    const criticals = [
        counts.criticals ? `${pluralise(counts.criticals, 'thread')} didn't complete due to critical errors` : null,
        counts.timeouts ? `${pluralise(counts.timeouts, 'thread')} didn't complete due to timing out` : null,
        counts.stopped ? `${pluralise(counts.stopped, 'thread')} didn't complete because a thread in an earlier phase failed` : null,
    ];

    const crashSummary = Object.entries(crashes)
        .sort(([a], [b]) => b - a)
        .map(([times, threadCount]) => `${pluralise(threadCount, 'thread')} crashed ${pluralise(Number(times), 'time')}`);

    const testSummary = testStats?.total
        ? `${testStats.passed} of ${pluralise(testStats.total - testStats.skipped, 'test')} passed (${testStats.successPercentage}%)${testStats.skipped ? `, with ${testStats.skipped} skipped` : ''}`
        : null;

    const summaryParts = [
        testSummary,
        assumedPassedSpecCount ? `${pluralise(assumedPassedSpecCount, "spec file wasn't", "spec files weren't")} re-run, so ${testStats.assumedPassed === 1 ? 'its test is' : 'their tests are'} assumed to have passed previously and marked as skipped (${testStats.assumedPassed})` : null,
        counts.noSpecs ? `${pluralise(counts.noSpecs, 'thread')} didn't contain any spec files` : null,
        counts.missingResults ? `Test results are missing from ${pluralise(counts.missingResults, 'thread')}` : null,
        arrToNaturalStr(criticals),
        arrToNaturalStr(crashSummary),
        counts.retriedAfterFailing ? `${pluralise(counts.retriedAfterFailing, 'thread')} failed and had to be retried` : null,
        counts.retriedAfterStopping ? `${pluralise(counts.retriedAfterStopping, 'thread was', 'threads were')} retried because a thread in an earlier phase failed` : null,
        testStats?.filledIn ? `${pluralise(testStats.filledIn, 'test')} didn't produce a result and ${testStats.filledIn === 1 ? 'has' : 'have'} been filled in` : null,
        arrToNaturalStr(describeFailCounts(allFailedAttempts)),
    ].filter(Boolean);

    const anyProblems = summaryParts.length > (testSummary ? 1 : 0) + (assumedPassedSpecCount ? 1 : 0);
    const summary = anyProblems ? summaryParts.join('. ') : [...summaryParts, 'No tests failed!'].join('. ');

    const reportText = `See below to compare how each thread performed.\n\n${bars}${longest ? `The percentages given above represent how much time individual threads took to complete relative to thread #${longest.threadNo}, which was the longest at ${secondsToNaturalString(longest.secs)}. ` : ''}Any thread that takes significantly longer than others will be a bottleneck, so the closer the percentages are to one another, the better. A wide range in percentages indicates that the threads could be balanced more efficiently. Be alert as to whether any thread/test needed retrying, because that will skew the results for the affected threads.`;

    return { entries, summary, reportText };
};

module.exports = {
    buildThreadReport,
    threadStatus,
    threadWarning,
    describeFailCounts,
};
