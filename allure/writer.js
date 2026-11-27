const { allureCypress } = require('@benchesh/allure-cypress/reporter');

/**
 * @param {Function} on the `on` function given to setupNodeEvents
 * @param {object} config the config given to setupNodeEvents
 * @param {object} [allureConfig] passed on to allure-cypress
 * @param {object} [options]
 * @param {boolean} [options.useFallbackDir] write the results to the thread's `_fallback` directory instead of
 * its main one. The runner only uses the fallback results when nothing was written to the main directory, so
 * this is for when another Allure writer is writing there too (false by default)
 */
module.exports = (on, config, allureConfig, { useFallbackDir = false } = {}) => {
  const { allureResults } = config.env;
  const resultsDir = allureResults && useFallbackDir ? `${allureResults}_fallback` : allureResults;

  allureCypress(on, config, {
    ...allureConfig,
    // without the allureResults env variable (i.e. when not run by the runner) allure-cypress picks the directory
    ...(resultsDir ? { resultsDir } : {}),
  });
};
