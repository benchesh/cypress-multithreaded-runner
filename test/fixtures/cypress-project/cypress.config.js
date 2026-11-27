const fs = require('fs');
const path = require('path');
const { defineConfig } = require('cypress');
const allureWriter = require('../../../allure/writer');
const readComputedLabel = require('./cypress/plugins/computedLabel');

module.exports = defineConfig({
    e2e: {
        supportFile: 'cypress/support/e2e.js',
        specPattern: 'cypress/e2e/**/*.cy.js',
        video: false,
        // Cypress takes a screenshot when a test fails, which Allure attaches to the test. Tests set CMR_SCREENSHOTS_DIR
        // so that each scenario keeps its own screenshots. Cypress would otherwise clear the screenshots of every
        // thread each time one starts
        screenshotOnRunFailure: true,
        ...(process.env.CMR_SCREENSHOTS_DIR ? { screenshotsFolder: process.env.CMR_SCREENSHOTS_DIR } : {}),
        trashAssetsBeforeRuns: false,
        setupNodeEvents(on, config) {
            allureWriter(on, config);

            // only known once setupNodeEvents has run, like a value read from a .env file. The titles of the tests in
            // cypress/e2e/computed-titles include it, so test discovery has to run setupNodeEvents to know them
            config.expose = { ...config.expose, computedLabel: readComputedLabel() };

            on('task', {
                // how many times it's been called for a key (see cypress/support/runCount.js), including this time
                countRuns({ markerDir, key }) {
                    const file = path.join(markerDir, key.replace(/[^\w.-]+/g, '_'));
                    const count = (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0) + 1;

                    fs.mkdirSync(markerDir, { recursive: true });
                    fs.writeFileSync(file, String(count));

                    return count;
                },
            });

            return config;
        },
    },
});
