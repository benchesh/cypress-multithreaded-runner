const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    containsCrashPattern,
    hasRunStarted,
    hasRunFinished,
    allSpecsPassed,
    noSpecFilesFound,
    parseResultsTable,
    parseRetriedTests,
    CrashDetector,
} = require('../../lib/cypress/logAnalysis');

// real Cypress 15 output, captured from the fixture project
const output = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cypress-output', `${name}.log`), 'utf8');

describe('logAnalysis (real Cypress output)', () => {
    it('detects the start and end of a run', () => {
        assert.equal(hasRunStarted(output('pass')), true);
        assert.equal(hasRunFinished(output('pass')), true);
        assert.equal(hasRunStarted('Opening Cypress...'), false);
        assert.equal(hasRunFinished('(Run Starting)'), false);
    });

    it('detects whether all specs passed', () => {
        assert.equal(allSpecsPassed(output('pass')), true);
        assert.equal(allSpecsPassed(output('flaky')), true);
        assert.equal(allSpecsPassed(output('fail')), false);
    });

    it('detects crashes, such as failures in a before hook', () => {
        assert.equal(containsCrashPattern(output('hook-crash')), true);
        assert.equal(containsCrashPattern(output('pass')), false);
        assert.equal(containsCrashPattern(output('fail')), false);
    });

    it('parses the results table', () => {
        assert.deepEqual(parseResultsTable(output('fail')), { tests: 2, passing: 1, failing: 1, pending: 0, skipped: 0 });
        assert.deepEqual(parseResultsTable(output('loops')), { tests: 6, passing: 5, failing: 0, pending: 1, skipped: 0 });
        assert.equal(parseResultsTable('no table here'), null);
    });

    it('finds tests that needed retrying', () => {
        assert.deepEqual([...parseRetriedTests(output('flaky'))], [['passes on the second attempt', 1]]);
        assert.equal(parseRetriedTests(output('pass')).size, 0);
    });

    it('detects missing spec files', () => {
        assert.equal(noSpecFilesFound('Can\'t run because no spec files were found.'), true);
        assert.equal(noSpecFilesFound(output('pass')), false);
    });
});

describe('CrashDetector', () => {
    it('detects patterns split across chunks', () => {
        const detector = new CrashDetector();

        assert.equal(detector.push('Because this error occurred during a `bef'), false);
        assert.equal(detector.push('ore all` hook we are skipping'), true);
    });

    it('ignores normal output', () => {
        const detector = new CrashDetector();
        output('pass').match(/.{1,50}/gs).forEach((chunk) => assert.equal(detector.push(chunk), false));
    });
});
