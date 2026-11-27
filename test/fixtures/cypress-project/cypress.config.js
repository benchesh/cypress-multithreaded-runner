const { defineConfig } = require('cypress');
const allureWriter = require('../../../allure/writer');

module.exports = defineConfig({
    e2e: {
        supportFile: 'cypress/support/e2e.js',
        specPattern: 'cypress/e2e/**/*.cy.js',
        video: false,
        screenshotOnRunFailure: false,
        setupNodeEvents(on, config) {
            allureWriter(on, config);
            return config;
        },
    },
});
