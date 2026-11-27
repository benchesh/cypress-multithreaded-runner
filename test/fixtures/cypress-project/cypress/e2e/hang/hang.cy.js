describe('Hang', () => {
    it('passes before the hang', () => {
        expect(1).to.equal(1);
    });

    it('hangs', () => {
        cy.wait(10 * 60 * 1000);
    });

    ['a', 'b'].forEach((letter) => {
        it(`never reached ${letter}`, () => {
            expect(1).to.equal(1);
        });
    });
});
