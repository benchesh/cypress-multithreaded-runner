// Asynchronous API: `const exitCode = await require('cypress-multithreaded-runner/async')(config)`

const { mergeCliOverrides } = require('./lib/config/settings');
const { run } = require('./lib/run');

/**
 * @param {object} [config] see the README for every option. CLI arguments take precedence
 * @returns {Promise<number>} 0 if every test passed, otherwise 1
 */
module.exports = (config = {}) => run(mergeCliOverrides(config));
