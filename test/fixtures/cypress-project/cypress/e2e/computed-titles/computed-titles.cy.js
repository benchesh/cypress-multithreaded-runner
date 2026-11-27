// The titles of these tests include a value that's set in setupNodeEvents (see cypress.config.js)
const label = Cypress.expose('computedLabel');

describe('Computed titles', () => {
    ['first', 'second', 'third'].forEach((name) => {
        it(`${name} test, ${label}`, () => {
            expect(label).to.equal('set in setupNodeEvents');
        });
    });
});
