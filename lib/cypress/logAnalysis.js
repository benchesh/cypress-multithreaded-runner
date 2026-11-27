// Pure functions for interpreting Cypress's console output

// Output that indicates Cypress hit an internal problem rather than a genuine test failure.
// When seen, the thread is restarted (see maxThreadRestarts)
const CRASH_PATTERNS = [
    'uncaught error was detected outside of a test',
    'we are skipping the remaining tests in the current suite',
    'we have failed the current spec',
    'we detected that the chromium renderer process just crashed',
    'cypress could not associate this error to any specific test.',
    'cypress: fatal io error',
    'webpack compilation error',
    'this error occurred during a `before',
];

const containsCrashPattern = (text) => {
    const lowercase = String(text).toLowerCase();
    return CRASH_PATTERNS.some((pattern) => lowercase.includes(pattern));
};

const hasRunStarted = (text) => String(text).toLowerCase().includes('(run starting)');

const hasRunFinished = (text) => String(text).includes('(Run Finished)');

const allSpecsPassed = (text) => String(text).includes('All specs passed');

const noSpecFilesFound = (text) => String(text).toLowerCase().includes('no spec files were found');

/**
 * Parse the numbers from the last "(Results)" table Cypress printed
 *
 * @returns {{tests: number, passing: number, failing: number, pending: number, skipped: number}|null}
 */
const parseResultsTable = (text) => {
    const blocks = String(text).split('(Results)');

    if (blocks.length < 2) {
        return null;
    }

    const block = blocks[blocks.length - 1];

    const read = (label) => {
        const match = block.match(new RegExp(`${label}:\\s+(\\d+)`));
        return match ? Number(match[1]) : 0;
    };

    return {
        tests: read('Tests'),
        passing: read('Passing'),
        failing: read('Failing'),
        pending: read('Pending'),
        skipped: read('Skipped'),
    };
};

/**
 * Tests that needed retrying, according to the "(Attempt N of M) <test title>" lines that Cypress's
 * spec reporter prints for each failed attempt
 *
 * @returns {Map<string, number>} test title => number of failed attempts
 */
const parseRetriedTests = (text) => {
    const retried = new Map();

    for (const [, attempt, title] of String(text).matchAll(/\(Attempt (\d+) of \d+\) (.+)$/gm)) {
        retried.set(title.trim(), Math.max(retried.get(title.trim()) || 0, Number(attempt)));
    }

    return retried;
};

/**
 * Detects crash patterns in streamed output, including patterns split across chunks
 */
class CrashDetector {
    constructor() {
        this.tail = '';
        this.longestPattern = Math.max(...CRASH_PATTERNS.map((p) => p.length));
    }

    /**
     * @returns {boolean} whether this chunk (combined with the end of the previous one) contains a crash pattern
     */
    push(chunk) {
        const window = this.tail + chunk;
        this.tail = window.slice(-this.longestPattern);
        return containsCrashPattern(window);
    }
}

module.exports = {
    CRASH_PATTERNS,
    containsCrashPattern,
    hasRunStarted,
    hasRunFinished,
    allSpecsPassed,
    noSpecFilesFound,
    parseResultsTable,
    parseRetriedTests,
    CrashDetector,
};
