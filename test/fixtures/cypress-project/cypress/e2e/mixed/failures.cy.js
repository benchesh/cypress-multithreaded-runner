// The Allure adapter records every one of these as failed (including the thrown error)
describe('Failures', () => {
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
