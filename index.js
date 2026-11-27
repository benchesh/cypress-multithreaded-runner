// Synchronous API: `require('cypress-multithreaded-runner')(config)` blocks until every test has run.
// The runner itself executes in a child process

const { mergeCliOverrides } = require('./lib/config/settings');
const { runInChildProcess } = require('./lib/runSync');
const { runMaxConcurrentThreadsExperiment } = require('./lib/experiment');

/**
 * @param {object} [config] see the README for every option. CLI arguments take precedence
 */
module.exports = (config = {}) => {
    const mergedConfig = mergeCliOverrides(config);

    if (mergedConfig.maxConcurrentThreadsExperiment) {
        runMaxConcurrentThreadsExperiment(mergedConfig);
        return;
    }

    if (runInChildProcess(mergedConfig) !== 0) {
        process.exit(1); // exits in the same manner as async mode would
    }
};
