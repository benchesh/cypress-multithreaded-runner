// Runs every thread, then re-runs any that failed (see retryAllFailedSpecs). Retried threads keep their
// thread number; the logs and Allure results of every attempt are kept

const { Outcome, STOPPED_BY_EARLIER_PHASE } = require('./Thread');
const { arrToNaturalStr, orange, pluralise, secondsToNaturalString } = require('../util/format');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Threads worth retrying: anything that didn't pass, except threads where Cypress found no spec files. This
 * includes threads that were stopped (or never started) because a thread in an earlier phase failed
 */
const isRetryable = (thread) => thread.outcome !== Outcome.PASSED && thread.outcome !== Outcome.NO_SPECS;

const STOPPED_NOTES = {
    [Outcome.STOPPED]: ' (stopped)',
    [Outcome.NOT_RUN]: ' (didn\'t run)',
};

/**
 * e.g. "2 threads failed and 3 threads were stopped because a thread in an earlier phase failed", followed by each thread
 */
const describeRetry = (threads) => {
    const stopped = threads.filter((thread) => STOPPED_BY_EARLIER_PHASE.includes(thread.outcome)).length;
    const failed = threads.length - stopped;

    const reasons = arrToNaturalStr([
        failed ? `${pluralise(failed, 'thread')} failed` : null,
        stopped ? `${pluralise(stopped, 'thread was', 'threads were')} stopped because a thread in an earlier phase failed` : null,
    ]);

    const list = threads.map((thread) => `Thread #${thread.threadNo}: "${thread.spec}"${STOPPED_NOTES[thread.outcome] || ''}`).join('\n');

    return { reasons, list };
};

/**
 * @param {object} options
 * @param {import('./ThreadPool').ThreadPool} options.pool
 * @param {import('./Thread').Thread[]} options.threads
 * @param {number} options.retries retryAllFailedSpecs
 * @param {number} options.retryDelay retryAllFailedSpecsDelay, in seconds
 * @param {(msg: string) => void} [options.log]
 * @param {(ms: number) => Promise<void>} [options.wait]
 */
const runWithRetries = async ({ pool, threads, retries, retryDelay, log = console.log, wait = sleep }) => {
    await pool.run(threads);
    pool.killAll();

    for (let retryAttempt = 1; retryAttempt <= retries; retryAttempt++) {
        const failedThreads = threads.filter(isRetryable);

        if (!failedThreads.length) {
            return;
        }

        const delayStr = retryDelay ? ` in ${secondsToNaturalString(retryDelay)}` : '';

        const { reasons, list } = describeRetry(failedThreads);

        log(orange(`\n${reasons}. Retry attempt ${retryAttempt} of ${retries} will begin${delayStr}:\n${list}\n`));

        if (retryDelay) {
            await wait(retryDelay * 1000);
        }

        failedThreads.forEach((thread) => {
            thread.prepareRetry(`\nRetry attempt ${thread.attempts} of thread #${thread.threadNo}${retryDelay ? ` (after a delay of ${secondsToNaturalString(retryDelay)})` : ''}:\n`);
        });

        await pool.run(failedThreads);
        pool.killAll();
    }
};

module.exports = {
    runWithRetries,
    isRetryable,
};
