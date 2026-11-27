const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { parseCliArgs } = require('../../lib/config/cliArgs');
const { mergeCliOverrides, normaliseSettings } = require('../../lib/config/settings');
const { DEFAULT_CRASH_PATTERNS } = require('../../lib/cypress/crashPatterns');

const argv = (...args) => ['node', 'script.js', ...args];

describe('parseCliArgs', () => {
    it('returns nothing when no arguments are passed', () => {
        assert.deepEqual(parseCliArgs(argv()), {});
    });

    it('accepts kebab-case and camelCase, and resolves aliases', () => {
        const args = parseCliArgs(argv('--report-dir=reports', '--open', '--specs', 'a.cy.js', 'b.cy.js', '--max-concurrent-threads', '2'));

        assert.equal(args.reportDir, 'reports');
        assert.equal(args.openAllure, true);
        assert.deepEqual(args.specFiles, ['a.cy.js', 'b.cy.js']);
        assert.equal(args.maxConcurrentThreads, 2);
        assert.equal(args['report-dir'], undefined);
    });

    it('resolves the runFailedSpecFilesFromReportURL & runMostRecentlyFailedSpecFilesFromReportsDir aliases', () => {
        assert.equal(parseCliArgs(argv('--run-fails-from-url', 'http://x')).runFailedSpecFilesFromReportURL, 'http://x');
        assert.equal(parseCliArgs(argv('--run-recently-failed-from-reports-dir', 'dir')).runMostRecentlyFailedSpecFilesFromReportsDir, 'dir');
    });

    it('parses crashPatterns as a list of strings, even when they look like numbers', () => {
        assert.deepEqual(parseCliArgs(argv('--crash-patterns', 'Out of memory', '404')).crashPatterns, ['Out of memory', '404']);
        assert.deepEqual(parseCliArgs(argv('--crashPatterns=Boom')).crashPatterns, ['Boom']);
        assert.deepEqual(parseCliArgs(argv('--crash-patterns')).crashPatterns, []);
    });

    it('parses includeRepoPath as a URL, or a flag (including --no-include-repo-path)', () => {
        assert.equal(parseCliArgs(argv('--include-repo-path', 'https://github.com/acme/widgets/blob/main')).includeRepoPath, 'https://github.com/acme/widgets/blob/main');
        assert.equal(parseCliArgs(argv('--no-include-repo-path')).includeRepoPath, false);
        assert.equal(normaliseSettings(parseCliArgs(argv('--include-repo-path', 'false'))).includeRepoPath, false);
        assert.equal(normaliseSettings(parseCliArgs(argv('--include-repo-path'))).includeRepoPath, true);
    });

    it('parses numbers and dotted options', () => {
        const args = parseCliArgs(argv('--retry-all-failed-specs', '2', '--wait-for-file-exist.timeout', '5'));

        assert.equal(args.retryAllFailedSpecs, 2);
        assert.deepEqual(args.waitForFileExist, { timeout: 5 });
    });
});

describe('mergeCliOverrides', () => {
    it('lets the CLI override the config, merging nested objects', () => {
        const merged = mergeCliOverrides(
            { reportDir: 'a', waitForFileExist: { filepath: 'file.txt', timeout: 60 } },
            { reportDir: 'b', waitForFileExist: { timeout: 5 } },
        );

        assert.equal(merged.reportDir, 'b');
        assert.deepEqual(merged.waitForFileExist, { filepath: 'file.txt', timeout: 5 });
    });

    it('honours ignoreCliOverrides', () => {
        const merged = mergeCliOverrides(
            { grep: 'from config', ignoreCliOverrides: ['grep'] },
            { grep: 'from cli', reportDir: 'cli' },
        );

        assert.equal(merged.grep, 'from config');
        assert.equal(merged.reportDir, 'cli');
    });
});

describe('normaliseSettings', () => {
    it('applies the documented defaults', () => {
        const settings = normaliseSettings({ phases: [{ specsDir: 'specs' }] });

        assert.equal(settings.clean, false);
        assert.equal(settings.generateAllure, true);
        assert.equal(settings.openAllure, false);
        assert.equal(settings.combineAllure, true);
        assert.equal(settings.hostAllure, false);
        assert.equal(settings.overwriteAllureHistory, true);
        assert.equal(settings.logMode, 1);
        assert.equal(settings.maxThreadRestarts, 5);
        assert.deepEqual(settings.crashPatterns, DEFAULT_CRASH_PATTERNS);
        assert.equal(settings.includeRepoPath, true);
        assert.equal(settings.notify, true);
        assert.equal(settings.threadDelay, 30);
        assert.equal(settings.stopSubsequentPhasesOnFail, true);
        assert.equal(settings.threadInactivityTimeout, 600);
        assert.equal(settings.threadTimeLimit, 1800);
        assert.equal(settings.maxAllowedTimeouts, 4);
        assert.equal(settings.orderThreadsByBenchmark, true);
        assert.equal(settings.saveThreadBenchmark, true);
        assert.equal(settings.threadBenchmarkFilepath, 'cmr-benchmarks.json');
        assert.equal(settings.repeat, 1);
        assert.equal(settings.retryAllFailedSpecs, 0);
        assert.equal(settings.retryAllFailedSpecsDelay, 0);
        assert.equal(settings.endProcessIfTestsFail, true);
        assert.equal(settings.waitForFileExist, null);
        assert.ok(settings.maxConcurrentThreads >= 1);
    });

    it('derives the Allure directories from the reportDir', () => {
        const settings = normaliseSettings({ reportDir: 'reports', phases: [{}] });

        assert.equal(settings.reportDir, path.resolve('reports'));
        assert.equal(settings.allureReportDir, path.join(path.resolve('reports'), 'allure-report'));
        assert.equal(settings.allureHistoryDir, path.resolve('reports', 'allure-results', 'history'));
        assert.equal(settings.heading, 'Cypress Multithreaded Runner');
        assert.equal(normaliseSettings({ allureReportHeading: 'Nightly' }).heading, 'Cypress Multithreaded Runner: Nightly');
    });

    it('merges phaseDefaults into each phase and titles them', () => {
        const settings = normaliseSettings({
            phaseDefaults: { grep: 'default grep', cypressConfig: { filepath: 'cypress.config.js', object: { a: 1 } } },
            phases: [{ specsDir: 'one', title: 'First' }, { specsDir: 'two', grep: 'override' }],
        });

        assert.equal(settings.phases.length, 2);
        assert.equal(settings.phases[0].title, '[PHASE #1: First]');
        assert.equal(settings.phases[1].title, '[PHASE #2]');
        assert.equal(settings.phases[0].grep, 'default grep');
        assert.equal(settings.phases[1].grep, 'override');
        assert.equal(settings.phases[0].cypressConfigFilepath, 'cypress.config.js');
        assert.deepEqual(settings.phases[1].cypressConfigObject, { a: 1 });
    });

    it('treats top-level phase options as a single phase when phases are not given (as in the README examples)', () => {
        const settings = normaliseSettings({ specsDir: 'src/cypress/tests', grep: 'my-test', onlyRunSpecFilesIncludingAllText: ['My-Test', 'my-tag'] });

        assert.equal(settings.phases.length, 1);
        assert.equal(settings.phases[0].specsDir, path.join('src/cypress/tests'));
        assert.equal(settings.phases[0].grep, 'my-test');
        assert.deepEqual(settings.phases[0].textFilters.includingAll, ['my-test', 'my-tag']);
    });

    it('normalises text filters: a single string becomes an array, empty arrays become null', () => {
        const [phase] = normaliseSettings({ phases: [{ onlyRunSpecFilesIncludingAnyText: 'ABC', onlyRunSpecFilesNotIncludingAnyText: [] }] }).phases;

        assert.deepEqual(phase.textFilters.includingAny, ['abc']);
        assert.equal(phase.textFilters.notIncludingAny, null);
    });

    it('lets crashPatterns replace the default crash patterns, lowercasing them and dropping blank ones', () => {
        const patterns = (crashPatterns) => normaliseSettings({ crashPatterns }).crashPatterns;

        assert.deepEqual(patterns(['Out Of Memory', 'Boom']), ['out of memory', 'boom']);
        assert.deepEqual(patterns('Boom'), ['boom']);
        assert.deepEqual(patterns(['Boom', '', '   ', null, {}, 404]), ['boom', '404']);

        // an empty list switches the patterns off. It doesn't fall back to the defaults
        assert.deepEqual(patterns([]), []);

        // anything else is ignored. A blank pattern must never be used, as it would match every line of output
        [undefined, null, 5, {}, true].forEach((value) => assert.deepEqual(patterns(value), DEFAULT_CRASH_PATTERNS, String(value)));
        assert.deepEqual(patterns(['', '  ']), []);

        // the defaults can't be changed through the settings
        patterns(undefined).push('oops');
        assert.ok(!DEFAULT_CRASH_PATTERNS.includes('oops'));
    });

    it('normalises includeRepoPath: anything falsy means no links, and only leaving it out means true', () => {
        const includeRepoPath = (value) => normaliseSettings({ includeRepoPath: value }).includeRepoPath;

        assert.equal(includeRepoPath(undefined), true);
        assert.equal(includeRepoPath(true), true);
        [false, null, 0, '', '  ', 'false', 'FALSE', '0', 'no'].forEach((value) => assert.equal(includeRepoPath(value), false, String(value)));
        ['true', '1', 'yes'].forEach((value) => assert.equal(includeRepoPath(value), true, value));
        assert.equal(includeRepoPath(' https://github.com/acme/widgets/blob/main '), 'https://github.com/acme/widgets/blob/main');
    });

    it('fills in waitForFileExist defaults', () => {
        const settings = normaliseSettings({ waitForFileExist: { filepath: 'cookies.json' } });

        assert.deepEqual(settings.waitForFileExist, {
            filepath: 'cookies.json',
            minSize: 2,
            timeout: 60,
            deleteAfterCompletion: false,
            stopWaitingWhenFirstThreadCompletes: true,
        });
    });

    it('sanitises numeric options', () => {
        const settings = normaliseSettings({ retryAllFailedSpecs: 2.7, retryAllFailedSpecsDelay: -1, repeat: 0, logMode: 9, threadDelay: 0 });

        assert.equal(settings.retryAllFailedSpecs, 2);
        assert.equal(settings.retryAllFailedSpecsDelay, 0);
        assert.equal(settings.repeat, 1);
        assert.equal(settings.logMode, 1);
        assert.equal(settings.threadDelay, 0);
    });
});
