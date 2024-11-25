const { allureCypress } = require('allure-cypress/reporter');

module.exports = (on, config, allureConfig) => allureCypress(on, config, {
    ...allureConfig,
    resultsDir: config.env.allureResults,
});
