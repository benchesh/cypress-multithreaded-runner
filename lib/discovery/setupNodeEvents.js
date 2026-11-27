// Runs the Cypress config file's e2e setupNodeEvents function, as Cypress does before every run, so that test
// discovery sees the same Cypress.env()/Cypress.expose() values that the spec files will. Without this, a spec
// file whose test titles include a value worked out in setupNodeEvents (e.g. from process.env) would be
// discovered with different titles to the ones Cypress reports.
//
// It runs in a separate process (see setupNodeEventsChild.js) which is killed once it has replied, so anything
// setupNodeEvents starts (e.g. a server) can't keep the runner alive, and it's given a time limit

const path = require('path');
const { fork } = require('child_process');

const CHILD_SCRIPT = path.join(__dirname, 'setupNodeEventsChild.js');
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_LENGTH = 2000;

/**
 * A copy of a value that can be sent between processes: functions are dropped, as are objects that have
 * already been seen (so circular references don't throw)
 */
const toJsonSafe = (value) => {
    const seen = new WeakSet();

    return JSON.parse(JSON.stringify(value ?? {}, (_key, val) => {
        if (typeof val === 'function' || typeof val === 'symbol') {
            return undefined;
        }

        if (val && typeof val === 'object') {
            if (seen.has(val)) {
                return undefined;
            }

            seen.add(val);
        }

        return val;
    }));
};

/**
 * @param {object} options
 * @param {string} options.configFile the Cypress config file
 * @param {object} options.config the resolved config to give setupNodeEvents, as Cypress would
 * @param {string} options.projectRoot setupNodeEvents runs in this directory
 * @param {number} [options.timeoutMs]
 * @returns {Promise<object>} the config after setupNodeEvents has run. Rejects if it threw, or took too long
 */
const runSetupNodeEvents = ({ configFile, config, projectRoot, timeoutMs = DEFAULT_TIMEOUT_MS }) => new Promise((resolve, reject) => {
    const child = fork(CHILD_SCRIPT, [], {
        cwd: projectRoot,
        execArgv: [],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // anything setupNodeEvents prints is only shown if it fails
    let output = '';
    const collect = (chunk) => {
        output = (output + chunk).slice(-MAX_OUTPUT_LENGTH);
    };

    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    let timer = null;

    const finish = (settle, value) => {
        if (settled) {
            return;
        }

        settled = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
        settle(value);
    };

    const withOutput = (message) => (output.trim() ? `${message}\n${output.trim()}` : message);

    timer = setTimeout(() => finish(reject, new Error(withOutput(`setupNodeEvents didn't finish within ${timeoutMs / 1000} seconds`))), timeoutMs);

    child.on('message', (message) => (message?.ok
        ? finish(resolve, message.config)
        : finish(reject, new Error(withOutput(message?.error || 'setupNodeEvents failed')))));
    child.on('error', (err) => finish(reject, err));
    child.on('exit', (code, signal) => finish(reject, new Error(withOutput(`setupNodeEvents exited (${signal || `code ${code}`}) without finishing`))));

    child.send({ configFile, config: toJsonSafe(config) });
});

module.exports = {
    runSetupNodeEvents,
    toJsonSafe,
    DEFAULT_TIMEOUT_MS,
};
