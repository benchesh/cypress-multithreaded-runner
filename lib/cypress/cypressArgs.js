// Builds the command line arguments for each Cypress instance

const path = require('path');

/**
 * Split an env string such as `a=1,b="x,y"` into [key, value] pairs (quotes are kept as given)
 */
const parseEnvPairs = (envString) => {
    if (!envString) {
        return [];
    }

    return [...String(envString).matchAll(/([^=,]+)=("[^"]*"|[^,]*)/g)].map(([, key, value]) => [key.trim(), value]);
};

const unquote = (value) => String(value).replace(/^"(.*)"$/, '$1');

/**
 * Convert an env string into an object of values, as Cypress would see them
 */
const envStringToObject = (envString) => Object.fromEntries(parseEnvPairs(envString).map(([key, value]) => [key, unquote(value)]));

/**
 * The phase-specific `--env` values (grep options, timestamp and any passthrough args)
 *
 * @param {object} phase normalised phase settings
 * @param {object} [options]
 * @param {number} [options.timestamp] omitted when building the benchmark id, so it stays stable between runs
 */
const phaseEnvString = (phase, { timestamp } = {}) => [
    phase.grepTags ? `grepTags="${phase.grepTags}"` : null,
    phase.grep ? `grep="${phase.grep}"` : null,
    phase.grepUntagged ? `grepUntagged="${phase.grepUntagged}"` : null,
    timestamp ? `timestamp="${timestamp}"` : null,
    phase.passthroughEnvArgs || null,
].filter(Boolean).join(',');

/**
 * @cypress/grep v6+ (Cypress 15.10+) reads its options via Cypress.expose() rather than Cypress.env(),
 * so every grep-related value is also passed with `--expose`
 */
const phaseExposeString = (phase) => parseEnvPairs(phaseEnvString(phase))
    .filter(([key]) => key.startsWith('grep'))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');

/**
 * The full `--env` value for a thread
 */
const threadEnvString = ({ phase, threadNo, allureResultsDir, timestamp }) => [
    'allure=true',
    'allureAddVideoOnPass=true',
    `allureResults=${path.join(allureResultsDir, String(threadNo))}`,
    phaseEnvString(phase, { timestamp }),
].filter(Boolean).join(',');

/**
 * @param {object} options
 * @param {object} options.phase normalised phase settings
 * @param {string} options.spec the spec file to run
 * @param {number} options.threadNo
 * @param {string} options.allureResultsDir
 * @param {number} options.timestamp
 * @param {string|null} [options.jUnitFile] the JUnit XML file to write, if JUnit reports are enabled
 * @param {boolean} [options.supportsExpose] whether the installed Cypress has the `--expose` flag
 * @returns {string[]}
 */
const buildCypressArgs = ({ phase, spec, threadNo, allureResultsDir, timestamp, jUnitFile = null, supportsExpose = false }) => {
    const args = ['run'];

    if (phase.browser) {
        args.push('--browser', phase.browser);
    }

    if (phase.cypressConfigFilepath) {
        args.push('--config-file', phase.cypressConfigFilepath);
    }

    if (jUnitFile) {
        args.push('--reporter', 'junit', '--reporter-options', JSON.stringify({ mochaFile: jUnitFile }));
    }

    args.push(
        '--e2e',
        '--config', JSON.stringify({ ...phase.cypressConfigObject, specPattern: [spec] }),
        '--env', threadEnvString({ phase, threadNo, allureResultsDir, timestamp }),
    );

    const expose = supportsExpose ? phaseExposeString(phase) : '';

    if (expose) {
        args.push('--expose', expose);
    }

    return args;
};

module.exports = {
    buildCypressArgs,
    phaseEnvString,
    phaseExposeString,
    threadEnvString,
    envStringToObject,
    parseEnvPairs,
};
