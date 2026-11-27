// Tests that behave differently each time they run: to simulate flaky tests, crashes, and spec files that only
// pass when they're retried. Runs are counted across Cypress retries, restarts of the thread and re-runs of the
// spec file. The retryMarker env value is a directory, in which the countRuns task (see cypress.config.js) keeps count

/**
 * How many times this has been called for `key`, including this time
 */
export const countRuns = (key) => cy.env(['retryMarker']).then(({ retryMarker }) => cy.task('countRuns', { markerDir: retryMarker, key: `${Cypress.spec.relative}:${key}` }));

/**
 * Fails the first `count` times the test runs, and passes after that. The failure is an assertion error, so
 * Allure records the test as failed rather than broken
 */
export const failOnFirstRuns = (count) => {
    countRuns(Cypress.currentTest.titlePath.join(' > ')).then((runNo) => {
        expect(runNo, `run number (this test fails for the first ${count})`).to.be.greaterThan(count);
    });
};
