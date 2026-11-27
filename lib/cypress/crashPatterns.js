// The default text that marks a Cypress crash. If the output Cypress prints in a thread (or the Allure results it
// writes) contains any of these, the thread is considered to have crashed and is restarted (see maxThreadRestarts)
// rather than failed. They're things Cypress prints when it hits an internal problem, rather than a genuine test failure.
//
// Matching is case-insensitive, so every pattern here must be lowercase.
//
// Users can replace this list with the crashPatterns option (see the README). It's replaced, not added to,
// so anyone who wants to keep some of these needs to copy them.

const DEFAULT_CRASH_PATTERNS = Object.freeze([
    'uncaught error was detected outside of a test',
    'we are skipping the remaining tests in the current suite',
    'we have failed the current spec',
    'we detected that the chromium renderer process just crashed',
    'cypress could not associate this error to any specific test.',
    'cypress: fatal io error',
    'webpack compilation error',
    'this error occurred during a `before',
]);

module.exports = {
    DEFAULT_CRASH_PATTERNS,
};
