// Gives tests a page to be on, so the screenshot Cypress takes when a test fails shows something.
// example.com is a domain reserved for testing. Its page is stubbed, so the tests need no internet connection
// and the screenshot shows the title of the test that took it

export const TEST_DOMAIN = 'https://example.com';

const escapeHtml = (str) => String(str).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const visitTestDomain = () => {
    const title = escapeHtml(Cypress.currentTest.titlePath.join(' > '));

    cy.intercept('GET', `${TEST_DOMAIN}/`, {
        headers: { 'content-type': 'text/html' },
        body: `<!DOCTYPE html>
<html>
<head><title>Test domain</title></head>
<body style="font-family: sans-serif; margin: 40px">
    <h1>${TEST_DOMAIN}</h1>
    <p>Cypress Multithreaded Runner test page</p>
    <p><strong>${title}</strong></p>
</body>
</html>`,
    });

    cy.visit(TEST_DOMAIN);
};
