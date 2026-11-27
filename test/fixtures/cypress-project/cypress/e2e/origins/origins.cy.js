// Like a spec that tests several sites in a loop, where each site's tests have their own baseUrl. When the origin
// changes, Cypress reloads the page and runs the spec again from the start, skipping the tests that already ran
const SITES = ['https://one.example.com', 'https://two.example.org', 'https://three.example.net'];

describe('Origins', () => {
    SITES.forEach((site, index) => {
        ['first', 'second'].forEach((name) => {
            it(`${name} test on site ${index + 1}`, { baseUrl: site }, () => {
                cy.intercept('GET', `${site}/`, { headers: { 'content-type': 'text/html' }, body: '<!DOCTYPE html><html><body>site</body></html>' });
                cy.visit('/');
                cy.location('origin').should('equal', site);
            });
        });
    });
});
