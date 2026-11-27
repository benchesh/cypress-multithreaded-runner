// Pure functions for interpreting Cypress's console output

const { DEFAULT_CRASH_PATTERNS } = require('./crashPatterns');

/**
 * @param {string} text
 * @param {string[]} [patterns] what counts as a crash (see the crashPatterns option)
 */
const containsCrashPattern = (text, patterns = DEFAULT_CRASH_PATTERNS) => {
    const lowercase = String(text).toLowerCase();
    return patterns.some((pattern) => lowercase.includes(String(pattern).toLowerCase()));
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
    /**
     * @param {string[]} [patterns] what counts as a crash (see the crashPatterns option). There may be none
     */
    constructor(patterns = DEFAULT_CRASH_PATTERNS) {
        this.patterns = patterns;
        this.tail = '';
        this.longestPattern = Math.max(0, ...patterns.map((p) => String(p).length));
    }

    /**
     * @returns {boolean} whether this chunk (combined with the end of the previous one) contains a crash pattern
     */
    push(chunk) {
        const window = this.tail + chunk;
        // (slice(-0) would keep everything, so with no patterns there's nothing to remember)
        this.tail = this.longestPattern ? window.slice(-this.longestPattern) : '';
        return containsCrashPattern(window, this.patterns);
    }
}

module.exports = {
    containsCrashPattern,
    hasRunStarted,
    hasRunFinished,
    allSpecsPassed,
    noSpecFilesFound,
    parseResultsTable,
    parseRetriedTests,
    CrashDetector,
};
