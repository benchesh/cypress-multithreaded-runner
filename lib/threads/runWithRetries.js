// Runs every thread, then re-runs any that failed (see retryAllFailedSpecs). Retried threads keep their
// thread number; the logs and Allure results of every attempt are kept

const { Outcome } = require('./Thread');
const { orange, pluralise, secondsToNaturalString } = require('../util/format');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Threads worth retrying: anything that didn't pass, except threads where Cypress found no spec files
 */
const isRetryable = (thread) => thread.outcome !== Outcome.PASSED && thread.outcome !== Outcome.NO_SPECS;

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

        log(orange(`\n${pluralise(failedThreads.length, 'thread')} failed. Retry attempt ${retryAttempt} of ${retries} will begin${delayStr}:\n${failedThreads.map((thread) => `Thread #${thread.threadNo}: "${thread.spec}"`).join('\n')}\n`));

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
