const items = ['a', 'b', 'c'];

describe('Loops', () => {
    items.forEach((item) => {
        it(`item ${item}`, () => {
            expect(item).to.be.a('string');
        });
    });

    Cypress._.times(2, (k) => {
        it(`times ${k}`, () => {
            expect(k).to.be.a('number');
        });
    });

    it.skip('is skipped', () => {});
});
