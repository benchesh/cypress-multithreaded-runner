const allureCypress = require('@mmisty/cypress-allure-adapter/plugins').configureAllureAdapterPlugins;

// TODO: Fallback dependency needed until this bug is fixed: https://github.com/mmisty/cypress-allure-adapter/issues/268
// We're using both as this dependency doesn't produce a report that's as comprehensive as the main one
const { allureCypress: allureCypressFallback } = require('allure-cypress/reporter');

module.exports = (on, config, allureConfig) => {
  allureCypress(on, config, allureConfig)
    && allureCypressFallback(on, config, {
      ...allureConfig,
      resultsDir: `${config.env.allureResults}_fallback`,
    });
};
