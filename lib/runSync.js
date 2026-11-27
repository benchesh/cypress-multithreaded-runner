// Runs the runner in a child process and blocks until it finishes

const path = require('path');
const { spawnSync } = require('child_process');
const { orange } = require('./util/format');

/**
 * @param {object} config the merged config (see mergeCliOverrides)
 * @returns {number} the child's exit code
 */
const runInChildProcess = (config) => {
    const hasFunctions = (config.customLogs || []).some((customLog) => typeof customLog?.generateContent === 'function');

    if (hasFunctions) {
        console.warn(orange('WARNING: customLogs generateContent functions are only supported when using cypress-multithreaded-runner/async, so they will be ignored.'));
    }

    const result = spawnSync(process.execPath, [path.join(__dirname, 'cli', 'runChild.js')], {
        input: JSON.stringify(config),
        stdio: ['pipe', 'inherit', 'inherit'],
        maxBuffer: Infinity,
    });

    return result.status ?? 1;
};

module.exports = {
    runInChildProcess,
};
