// A test marks itself as broken (rather than failed) with the Allure adapter's API, e.g. when the problem
// is with the test environment rather than the application under test
const breakTest = (message) => {
    cy.allure().testStatus('broken', { message });
    cy.then(() => {
        throw new Error(message);
    });
};

describe('Broken', () => {
    it('is broken by an unavailable environment', () => {
        breakTest('the test environment was unavailable');
    });

    it('is broken on every attempt', { retries: { runMode: 3 } }, () => {
        breakTest('the test environment is still unavailable');
    });

    it('passes', () => {
        expect(1).to.equal(1);
    });
});
