// allure-cypress records a test as broken, rather than failed, when it ends with an error that isn't an
// assertion error. That's how a problem with the test environment (as opposed to the application under
// test) shows up

import { visitTestDomain } from '../../support/testDomain';

const breakTest = (message) => {
    cy.then(() => {
        throw new Error(message);
    });
};

describe('Broken', { retries: { runMode: 3 } }, () => {
    beforeEach(() => {
        visitTestDomain();
    });

    it('is broken by an unavailable environment', () => {
        breakTest('the test environment was unavailable');
    });

    it('is broken on every attempt', () => {
        breakTest('the test environment is still unavailable');
    });

    it('passes', () => {
        expect(1).to.equal(1);
    });
});
