// Assertion errors are recorded as failed. The thrown error isn't an assertion error, so it's recorded as broken

import { visitTestDomain } from '../../support/testDomain';

describe('Failures', { retries: { runMode: 3 } }, () => {
    beforeEach(() => {
        visitTestDomain();
    });

    it('fails an expect assertion', () => {
        expect(1).to.equal(2);
    });

    it('fails a should assertion', () => {
        cy.wrap(1, { timeout: 100 }).should('equal', 2);
    });

    it('throws an error', () => {
        throw new Error('something unexpected happened');
    });

    it('passes', () => {
        expect(1).to.equal(1);
    });
});
