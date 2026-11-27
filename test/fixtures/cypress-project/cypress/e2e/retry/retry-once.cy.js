// Fails the first time the spec runs, then passes on subsequent runs. A marker file records the first run
describe('Retry once', () => {
    it('fails on the first run only', () => {
        const marker = Cypress.env('retryMarker');

        cy.exec(`test -f "${marker}"`, { failOnNonZeroExit: false }).then((result) => {
            // Cypress 15 renamed `code` to `exitCode`
            if ((result.exitCode ?? result.code) !== 0) {
                cy.writeFile(marker, 'first run happened');
                cy.then(() => {
                    throw new Error('first run fails');
                });
            }
        });
    });

    it('always passes', () => {
        expect(1).to.equal(1);
    });
});
