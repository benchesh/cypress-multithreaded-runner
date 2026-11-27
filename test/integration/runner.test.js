// End-to-end tests: these run real Cypress (and Allure, which needs Java) against test/fixtures/cypress-project.
// They take a few minutes. Run with `npm run test:integration`

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const { runScenario, generatedResults } = require('../helpers/runScenario');
const { createTempDir } = require('../helpers/tempDir');
const { readJsonSafe } = require('../../lib/util/fs');
const { parse } = require('node-html-parser');

// Every scenario gets its own time limit, rather than the whole suite sharing one: the suite as a whole takes a few
// minutes, and more with every scenario. A scenario that hangs is cancelled after this long
const SCENARIO_TIMEOUT = 5 * 60 * 1000;

const scenario = (name, fn) => it(name, { timeout: SCENARIO_TIMEOUT }, fn);

// allure-cypress prefixes the fullName of a result with "<package>:<spec path>#"
const titleOf = (fullName) => (fullName.includes('#') ? fullName.slice(fullName.indexOf('#') + 1) : fullName);

// the warning shown for a thread in the thread performance report, or null if it has none
const threadWarning = (run, threadNo) => {
    const entry = run.readReportFile('thread-performance-report.txt').match(new RegExp(`Thread #${threadNo} \\[[^\\]]+\\][^\\n]*\\n[^\\n]*`))[0];

    return entry.match(/\(WARNING: (.*)\)$/)?.[1] ?? null;
};

const statuses = (results) => results.map((result) => `${titleOf(result.fullName)}: ${result.status}`).sort();

describe('runner (real Cypress)', () => {
    scenario('runs every phase, counting every test up front (sync API)', async () => {
        const run = await runScenario('runs every phase, counting every test up front (sync API)', {
            phases: [{ specsDir: 'cypress/e2e/phase1' }, { specsDir: 'cypress/e2e/phase2' }],
        }, { sync: true });

        try {
            assert.equal(run.processExitCode, 0, run.output);
            assert.match(run.output, /12 tests found in 4 spec files/);

            // the Allure report and the runner agree on the totals
            assert.deepEqual(run.allureStatistic, { failed: 0, broken: 0, skipped: 1, passed: 11, unknown: 0, total: 12 });
            assert.equal(run.benchmark.successPercentage, 100);
            assert.equal(run.benchmark.tests.total, 12);
            assert.deepEqual(run.benchmark.fails, []);
            assert.equal(run.benchmark.order.length, 4);

            // the flaky test passed on its second attempt, so it's a warning
            assert.match(run.readReportFile('thread-performance-summary.txt'), /^11 of 11 tests passed \(100%\), with 1 skipped\. 1 test failed 1 time$/);
            assert.match(run.reportHtml, /id="cmr-run-config"/);
            assert.match(run.reportHtml, /runs every phase, counting every test up front \(sync API\)/);
            assert.match(run.reportHtml, /cmr-warn cmr-headline/);
            assert.ok(run.readReportFile('allure-report/complete.html').includes('cmr-run-config'));
            assert.match(run.readReportFile('cypress-logs/thread_1.txt'), /Start of thread #1/);
            assert.deepEqual(generatedResults(run.results), []);
        } finally {
            run.cleanup();
        }
    });

    scenario('stops subsequent phases when a test fails, adding their tests to the report as failed', async () => {
        const run = await runScenario('stops subsequent phases when a test fails, adding their tests to the report as failed', {
            phases: [{ specsDir: 'cypress/e2e/failing' }, { specsDir: 'cypress/e2e/phase1' }],
            maxConcurrentThreads: 1,
        });

        try {
            assert.equal(run.exitCode, 1, run.output);
            assert.deepEqual(run.allureStatistic, { failed: 4, broken: 0, skipped: 0, passed: 1, unknown: 0, total: 5 });

            // tests that didn't run because their phase was stopped are failures, so count against the success percentage
            assert.equal(run.benchmark.successPercentage, 20);
            assert.equal(run.benchmark.tests.notRun, 3);
            assert.deepEqual(run.benchmark.fails.sort(), [
                'cypress/e2e/failing/fail.cy.js',
                'cypress/e2e/phase1/flaky.cy.js',
                'cypress/e2e/phase1/pass.cy.js',
            ]);

            assert.deepEqual(statuses(generatedResults(run.results)), [
                'Flaky suite passes on the second attempt: failed',
                'Passing suite nested passes nested: failed',
                'Passing suite passes first: failed',
            ]);
            // the failing test was retried 3 times before giving up
            assert.match(run.output, /\(Attempt 3 of 4\) fails/);
            assert.match(run.readReportFile('thread-performance-summary.txt'), /1 test failed 4 times/);
            assert.match(run.reportHtml, /phase #1 failed/);
            assert.match(run.reportHtml, /didn't produce results have been added to this report \(3 as failed\)/);
        } finally {
            run.cleanup();
        }
    });

    scenario('fills in the tests a timed out thread never reached, so the report has every test', async () => {
        const run = await runScenario('fills in the tests a timed out thread never reached, so the report has every test', {
            phases: [{ specsDir: 'cypress/e2e/hang' }],
            threadTimeLimit: 20,
        });

        try {
            assert.equal(run.exitCode, 1, run.output);
            assert.deepEqual(run.allureStatistic, { failed: 0, broken: 3, skipped: 0, passed: 1, unknown: 0, total: 4 });
            assert.equal(run.benchmark.successPercentage, 25);

            const generated = generatedResults(run.results);
            assert.deepEqual(statuses(generated), ['Hang hangs: broken', 'Hang never reached a: broken', 'Hang never reached b: broken']);
            assert.match(generated[0].statusDetails.message, /went over the time limit of 20 seconds/);

            assert.match(run.readReportFile('thread-performance-summary.txt'), /1 thread didn't complete due to timing out/);
            assert.match(run.reportHtml, /\[CRITICAL ERRORS - PLEASE READ\]/);
            assert.match(run.reportHtml, /was stopped early/);
        } finally {
            run.cleanup();
        }
    });

    scenario('restarts a crashing thread up to maxThreadRestarts times', async () => {
        const run = await runScenario('restarts a crashing thread up to maxThreadRestarts times', {
            phases: [{ specsDir: 'cypress/e2e/crash' }],
            maxThreadRestarts: 1,
        });

        try {
            assert.equal(run.exitCode, 1, run.output);
            assert.match(run.output, /Restarting it \(restart 1 of a maximum of 1\)/);
            assert.match(run.output, /Giving up after 1 restart!/);
            assert.equal(run.allureStatistic.total, 2);
            assert.match(run.readReportFile('thread-performance-summary.txt'), /1 thread didn't complete due to critical errors/);
        } finally {
            run.cleanup();
        }
    });

    scenario('lets crashPatterns replace what is treated as a crash', async () => {
        const title = 'lets crashPatterns replace what is treated as a crash';

        // the spec file's before hook throws "before hook exploded". The default patterns treat that as a crash (see the previous test)
        const config = { phases: [{ specsDir: 'cypress/e2e/crash' }], maxThreadRestarts: 1 };

        const replaced = await runScenario(`${title} (patterns that don't match)`, { ...config, crashPatterns: ['this is never printed'] });
        const matching = await runScenario(`${title} (a pattern that matches)`, { ...config, crashPatterns: ['BEFORE HOOK EXPLODED'] });

        try {
            // Cypress still finished its run, so with the default patterns replaced it's a failed spec file rather than a crash
            assert.equal(replaced.exitCode, 1, replaced.output);
            assert.doesNotMatch(replaced.output, /Restarting it/);
            assert.doesNotMatch(replaced.readReportFile('thread-performance-summary.txt'), /crash/);
            assert.deepEqual(replaced.benchmark.fails, ['cypress/e2e/crash/hook-crash.cy.js']);

            // a pattern of the user's own (matched case-insensitively) is a crash, so the thread is restarted
            assert.equal(matching.exitCode, 1, matching.output);
            assert.match(matching.output, /Restarting it \(restart 1 of a maximum of 1\)/);
            assert.match(matching.output, /Giving up after 1 restart!/);
            assert.match(matching.readReportFile('thread-performance-summary.txt'), /1 thread didn't complete due to critical errors/);
        } finally {
            replaced.cleanup();
            matching.cleanup();
        }
    });

    scenario('only re-runs previously failed spec files, treating the rest as passed', async () => {
        const run = await runScenario('only re-runs previously failed spec files, treating the rest as passed', {
            phases: [{ specsDir: 'cypress/e2e/failing' }, { specsDir: 'cypress/e2e/phase1' }],
            runFailedSpecFilesFromObject: { previousRun: { fails: ['cypress/e2e/failing/fail.cy.js'] } },
        });

        try {
            assert.equal(run.exitCode, 1, run.output);
            assert.match(run.output, /1 thread will be created/);

            // fail.cy.js: 1 passed + 1 failed. pass.cy.js (2 tests) & flaky.cy.js (1 test) are assumed to have passed
            assert.deepEqual(run.allureStatistic, { failed: 1, broken: 0, skipped: 0, passed: 4, unknown: 0, total: 5 });
            assert.equal(run.benchmark.successPercentage, 80);
            assert.equal(run.benchmark.tests.assumedPassed, 3);
            assert.deepEqual(run.benchmark.fails, ['cypress/e2e/failing/fail.cy.js']);
            assert.match(run.reportHtml, /The other 2 spec files \(3 tests\) weren&#39;t run, and have been added to this report as passed/);
        } finally {
            run.cleanup();
        }
    });

    scenario('retries failed spec files with retryAllFailedSpecs, keeping every attempt in the report', async () => {
        const title = 'retries failed spec files with retryAllFailedSpecs, keeping every attempt in the report';
        const markerDir = path.join(os.tmpdir(), `cmr-retry-markers-${Date.now()}`);

        // phase 1 is threads #1-5 and phase 2 is threads #6-8. The spec files of threads #1, #2, #7 & #8 fail the first time they run
        const specs = {
            1: 'phase1/a-fails-first-time',
            2: 'phase1/b-fails-first-time',
            3: 'phase1/c-passes',
            4: 'phase1/d-passes',
            5: 'phase1/e-passes',
            6: 'phase2/a-passes',
            7: 'phase2/b-fails-first-time',
            8: 'phase2/c-fails-first-time',
        };

        const run = await runScenario(title, {
            phases: [
                { specsDir: 'cypress/e2e/retry-phases/phase1', passthroughEnvArgs: `retryMarker=${markerDir}` },
                { specsDir: 'cypress/e2e/retry-phases/phase2', passthroughEnvArgs: `retryMarker=${markerDir}` },
            ],
            stopSubsequentPhasesOnFail: true,
            maxConcurrentThreads: 3,
            retryAllFailedSpecs: 3,
            retryAllFailedSpecsDelay: 1,
        });

        const listed = (threadNo, note = '') => `Thread #${threadNo}: "cypress/e2e/retry-phases/${specs[threadNo]}.cy.js"${note}`;

        // the order in which a thread ran Cypress and was retried, from its log
        const timeline = (threadNo) => [...run.readReportFile(`cypress-logs/thread_${threadNo}.txt`).matchAll(new RegExp(`Start of thread #${threadNo}:|Retry attempt (\\d+) of thread #${threadNo}`, 'g'))]
            .map(([, attempt]) => (attempt ? `retry ${attempt}` : 'ran Cypress'));

        try {
            assert.equal(run.exitCode, 0, run.output);
            assert.match(run.output, /8 tests found in 8 spec files/);

            // the first run: threads #1 & #2 fail, so phase 2 is cancelled before it starts
            assert.match(run.output, /Thread #[12] failed, and as it's from phase #1, all threads from following phases will be stopped immediately/);

            // retry 1: threads #1 & #2 re-run along with phase 2, where threads #7 & #8 fail
            assert.ok(run.output.includes([
                '2 threads failed and 3 threads were stopped because a thread in an earlier phase failed. Retry attempt 1 of 3 will begin in 1 second:',
                listed(1),
                listed(2),
                listed(6, ' (didn\'t run)'),
                listed(7, ' (didn\'t run)'),
                listed(8, ' (didn\'t run)'),
            ].join('\n')), run.output);

            // retry 2: threads #7 & #8 re-run and pass, leaving nothing to retry a third time
            assert.ok(run.output.includes([
                '2 threads failed. Retry attempt 2 of 3 will begin in 1 second:',
                listed(7),
                listed(8),
            ].join('\n')), run.output);
            assert.doesNotMatch(run.output, /Retry attempt 3 of 3/);

            assert.deepEqual(Object.keys(specs).map(Number).map(timeline), [
                ['ran Cypress', 'retry 1', 'ran Cypress'],
                ['ran Cypress', 'retry 1', 'ran Cypress'],
                ['ran Cypress'],
                ['ran Cypress'],
                ['ran Cypress'],
                ['retry 1', 'ran Cypress'],
                ['retry 1', 'ran Cypress', 'retry 2', 'ran Cypress'],
                ['retry 1', 'ran Cypress', 'retry 2', 'ran Cypress'],
            ]);

            // every attempt is in the report. Allure shows each test once, with its failed attempt as a retry
            assert.deepEqual(run.allureStatistic, { failed: 0, broken: 0, skipped: 0, passed: 8, unknown: 0, total: 8 });
            assert.deepEqual(generatedResults(run.results), []);
            assert.deepEqual(statuses(run.results), [
                'Phase 1 spec A fails on the first run only: failed',
                'Phase 1 spec A fails on the first run only: passed',
                'Phase 1 spec B fails on the first run only: failed',
                'Phase 1 spec B fails on the first run only: passed',
                'Phase 1 spec C passes: passed',
                'Phase 1 spec D passes: passed',
                'Phase 1 spec E passes: passed',
                'Phase 2 spec A passes: passed',
                'Phase 2 spec B fails on the first run only: failed',
                'Phase 2 spec B fails on the first run only: passed',
                'Phase 2 spec C fails on the first run only: failed',
                'Phase 2 spec C fails on the first run only: passed',
            ]);

            const testCaseDir = path.join(run.reportDir, 'allure-report', 'data', 'test-cases');
            const shown = fs.readdirSync(testCaseDir)
                .map((file) => fs.readJsonSync(path.join(testCaseDir, file)))
                .filter((testCase) => !testCase.hidden) // hidden test cases are the earlier attempts
                .map((testCase) => `${titleOf(testCase.fullName)}: ${testCase.status}, ${testCase.retriesCount} retries`)
                .sort();

            assert.deepEqual(shown, [
                'Phase 1 spec A fails on the first run only: passed, 1 retries',
                'Phase 1 spec B fails on the first run only: passed, 1 retries',
                'Phase 1 spec C passes: passed, 0 retries',
                'Phase 1 spec D passes: passed, 0 retries',
                'Phase 1 spec E passes: passed, 0 retries',
                'Phase 2 spec A passes: passed, 0 retries',
                'Phase 2 spec B fails on the first run only: passed, 1 retries',
                'Phase 2 spec C fails on the first run only: passed, 1 retries',
            ]);

            assert.equal(run.benchmark.successPercentage, 100);
            assert.deepEqual(run.benchmark.fails, []);

            // the reports tell threads that failed apart from threads that were only retried because phase 1 failed
            assert.equal(
                run.readReportFile('thread-performance-summary.txt'),
                '8 of 8 tests passed (100%). 4 threads failed and had to be retried. 3 threads were retried because a thread in an earlier phase failed. 4 tests failed 1 time',
            );

            // each attempt of a retried thread is described separately
            const failedOnce = 'In the first attempt: 1 test failed 1 time and the spec file failed. In the second attempt: the spec file passed';
            const stoppedThenFailed = 'In the first attempt: the thread didn\'t run because a thread in an earlier phase failed. In the second attempt: 1 test failed 1 time and the spec file failed. In the third attempt: the spec file passed';

            assert.deepEqual(Object.keys(specs).map(Number).map((threadNo) => threadWarning(run, threadNo)), [
                failedOnce,
                failedOnce,
                null,
                null,
                null,
                'In the first attempt: the thread didn\'t run because a thread in an earlier phase failed. In the second attempt: the spec file passed',
                stoppedThenFailed,
                stoppedThenFailed,
            ]);
        } finally {
            fs.rmSync(markerDir, { recursive: true, force: true });
            run.cleanup();
        }
    });

    scenario('keeps Allure history between runs, so the report shows trends and each test\'s previous results', async () => {
        const title = 'keeps Allure history between runs, so the report shows trends and each test\'s previous results';
        const markerDir = path.join(os.tmpdir(), `cmr-history-markers-${Date.now()}`);
        const historyTemp = createTempDir();
        const runs = [];

        // 'fails on the first run only' fails in run 1 and passes in runs 2 & 3; fail.cy.js's 'fails' always fails
        const config = {
            phases: [
                { specsDir: 'cypress/e2e/retry', passthroughEnvArgs: `retryMarker=${markerDir}` },
                { specsDir: 'cypress/e2e/failing' },
            ],
            stopSubsequentPhasesOnFail: false,
        };

        try {
            for (const runNo of [1, 2, 3]) {
                // every run uses its own report directory, but they all read & write the same history directory
                runs.push(await runScenario(`${title} (run ${runNo})`, config, { historyDir: historyTemp.file('history') }));
            }

            assert.deepEqual(runs.map((run) => run.exitCode), [1, 1, 1], runs.map((run) => run.output).join('\n'));
            assert.deepEqual(
                runs.map((run) => [run.allureStatistic.failed, run.allureStatistic.passed, run.allureStatistic.total]),
                [[2, 2, 4], [1, 3, 4], [1, 3, 4]],
            );

            // the trend: the latest run is first, followed by every earlier run
            const trend = (run) => (readJsonSafe(path.join(run.reportDir, 'allure-report', 'history', 'history-trend.json'), []))
                .map(({ data }) => [data.failed, data.passed, data.total]);

            assert.deepEqual(trend(runs[0]), [[2, 2, 4]]);
            assert.deepEqual(trend(runs[1]), [[1, 3, 4], [2, 2, 4]]);
            assert.deepEqual(trend(runs[2]), [[1, 3, 4], [1, 3, 4], [2, 2, 4]]);

            // each test in the report lists its results from earlier runs (latest first), as shown in Allure's "History" tab
            const testCaseDir = path.join(runs[2].reportDir, 'allure-report', 'data', 'test-cases');
            const testCases = fs.readdirSync(testCaseDir)
                .map((file) => fs.readJsonSync(path.join(testCaseDir, file)))
                .filter((testCase) => !testCase.hidden); // hidden test cases are retry attempts, which have no history
            const previousStatuses = (fullName) => testCases.find((testCase) => titleOf(testCase.fullName) === fullName).extra.history.items.map((item) => item.status);

            assert.deepEqual(previousStatuses('Retry once fails on the first run only'), ['passed', 'failed']);
            assert.deepEqual(previousStatuses('Retry once always passes'), ['passed', 'passed']);
            assert.deepEqual(previousStatuses('Failing suite fails'), ['failed', 'failed']);
            assert.deepEqual(previousStatuses('Failing suite passes'), ['passed', 'passed']);

            // the history saved for the next run has one entry per test, each with a result from all 3 runs
            const savedHistory = Object.values(readJsonSafe(path.join(runs[2].reportDir, 'allure-report', 'history', 'history.json'), {}));

            assert.equal(savedHistory.length, 4);
            assert.ok(savedHistory.every((entry) => entry.items.length === 3));

            // the history is also saved in the shared directory, ready for the next run
            assert.ok(fs.existsSync(historyTemp.file('history', 'history-trend.json')));
            assert.equal(runs[2].benchmark.successPercentage, 75);
        } finally {
            runs.forEach((run) => run.cleanup());
            fs.rmSync(markerDir, { recursive: true, force: true });
            historyTemp.cleanup();
        }
    });

    scenario('reports a mix of passed, failed, broken, skipped and retried tests', async () => {
        const markerDir = path.join(os.tmpdir(), `cmr-mixed-markers-${Date.now()}`);

        // every spec file retries its tests 3 times (4 attempts), and the thread numbers are in alphabetical order:
        //  #1 broken.cy.js                      a broken test that never recovers
        //  #2 crashes-twice.cy.js               crashes twice (the thread is restarted), then passes
        //  #3 failures.cy.js                    tests that fail, and one that throws
        //  #4 passes-after-spec-retry.cy.js     a test fails all 4 attempts, so the spec file only passes when the runner retries it
        //  #5 passes-after-test-retries.cy.js   every test passes, but one needs 2 retries first
        //  #6 retries.cy.js                     tests that pass on their 2nd, 3rd & 4th attempts, and one that never does
        //  #7 skipped.cy.js                     tests that are skipped in various ways
        const run = await runScenario('reports a mix of passed, failed, broken, skipped and retried tests', {
            phases: [{ specsDir: 'cypress/e2e/mixed', passthroughEnvArgs: `retryMarker=${markerDir}` }],
            maxConcurrentThreads: 4,
            retryAllFailedSpecs: 1,
        });

        try {
            assert.equal(run.exitCode, 1, run.output);
            assert.match(run.output, /24 tests found in 7 spec files/);

            // threads #1, #3, #4 & #6 fail the first time. They're retried (as is every failing thread), but #4 is the only one that passes
            assert.ok(run.output.includes([
                '4 threads failed. Retry attempt 1 of 1 will begin:',
                'Thread #1: "cypress/e2e/mixed/broken.cy.js"',
                'Thread #3: "cypress/e2e/mixed/failures.cy.js"',
                'Thread #4: "cypress/e2e/mixed/passes-after-spec-retry.cy.js"',
                'Thread #6: "cypress/e2e/mixed/retries.cy.js"',
            ].join('\n')), run.output);

            assert.deepEqual(run.allureStatistic, { failed: 3, broken: 3, skipped: 6, passed: 12, unknown: 0, total: 24 });
            assert.deepEqual(generatedResults(run.results), []);

            // 12 passed out of 18 (24 tests, minus the 6 that were skipped)
            assert.equal(run.benchmark.successPercentage, 66.67);
            assert.deepEqual(run.benchmark.fails.sort(), [
                'cypress/e2e/mixed/broken.cy.js',
                'cypress/e2e/mixed/failures.cy.js',
                'cypress/e2e/mixed/retries.cy.js',
            ]);

            // Cypress retried these tests 3 times (4 attempts)
            assert.match(run.output, /\(Attempt 3 of 4\) fails every attempt/);
            assert.match(run.output, /\(Attempt 3 of 4\) passes on the fourth attempt/);
            assert.match(run.output, /\(Attempt 2 of 4\) passes on the third attempt/);
            assert.doesNotMatch(run.output, /\(Attempt 3 of 4\) passes on the third attempt/);
            assert.match(run.output, /\(Attempt 3 of 4\) is broken on every attempt/);
            assert.doesNotMatch(run.output, /\(Attempt 2 of 4\) passes on the second attempt/);
            assert.match(run.output, /\(Attempt 2 of 4\) is retried twice before it passes/);
            assert.doesNotMatch(run.output, /\(Attempt 3 of 4\) is retried twice before it passes/);
            assert.match(run.output, /\(Attempt 3 of 4\) only passes when the spec file is retried/);

            // thread #2 crashed twice, and succeeded on its third run. It wasn't retried by retryAllFailedSpecs as it passed
            assert.match(run.output, /thread #2! Restarting it \(restart 1 of a maximum of 5\)/);
            assert.match(run.output, /thread #2! Restarting it \(restart 2 of a maximum of 5\)/);
            assert.doesNotMatch(run.output, /thread #2! Restarting it \(restart 3/);
            assert.doesNotMatch(run.readReportFile('cypress-logs/thread_2.txt'), /Retry attempt/);

            // failed attempts across both runs of a thread are counted: 8 for a test that fails every attempt, as threads #1, #3 & #6
            // are run again by retryAllFailedSpecs. A test that passes on the 4th attempt fails 3 times in each run
            assert.equal(
                run.readReportFile('thread-performance-summary.txt'),
                '12 of 18 tests passed (66.67%), with 6 skipped. 1 thread crashed 2 times. 4 threads failed and had to be retried. 6 tests failed 8 times, 1 test failed 6 times, 2 tests failed 4 times and 2 tests failed 2 times',
            );

            // a thread that was retried by retryAllFailedSpecs describes each of its attempts separately
            assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((threadNo) => threadWarning(run, threadNo)), [
                'In the first attempt: 2 tests failed 4 times and the spec file failed. In the second attempt: 2 tests failed 4 times and the spec file failed',
                'The thread needed restarting 2 times',
                'In the first attempt: 3 tests failed 4 times and the spec file failed. In the second attempt: 3 tests failed 4 times and the spec file failed',
                'In the first attempt: 1 test failed 4 times and the spec file failed. In the second attempt: the spec file passed',
                '1 test failed 2 times',
                'In the first attempt: 1 test failed 4 times, 1 test failed 3 times, 1 test failed 2 times, 1 test failed 1 time and the spec file failed. In the second attempt: 1 test failed 4 times, 1 test failed 3 times, 1 test failed 2 times, 1 test failed 1 time and the spec file failed',
                null,
            ]);

            // every attempt of every run is kept, and Allure shows each test once with its earlier attempts as retries
            const attemptsOf = (name) => run.results.filter((result) => result.name === name).map((result) => result.status).sort();
            const times = (count, status) => Array(count).fill(status);

            assert.deepEqual(attemptsOf('fails every attempt'), times(8, 'failed'));
            assert.deepEqual(attemptsOf('passes on the fourth attempt'), [...times(6, 'failed'), ...times(2, 'passed')]);
            assert.deepEqual(attemptsOf('passes on the third attempt'), [...times(4, 'failed'), ...times(2, 'passed')]);
            assert.deepEqual(attemptsOf('passes on the second attempt'), [...times(2, 'failed'), ...times(2, 'passed')]);
            assert.deepEqual(attemptsOf('is broken on every attempt'), times(8, 'broken'));
            assert.deepEqual(attemptsOf('is retried twice before it passes'), ['failed', 'failed', 'passed']);
            assert.deepEqual(attemptsOf('only passes when the spec file is retried'), [...times(4, 'failed'), 'passed']);
            assert.deepEqual(attemptsOf('passes every time'), ['passed', 'passed']);

            // the results of the crashed runs were cleared, leaving only the run that worked
            assert.deepEqual(run.results.filter((result) => titleOf(result.fullName).startsWith('Crashes ')).map((result) => `${result.name}: ${result.status}`).sort(), [
                'also runs once Cypress stops crashing: passed',
                'runs once Cypress stops crashing: passed',
            ]);

            // Cypress takes a screenshot (of the test domain) whenever an attempt fails, and Allure attaches it to that attempt
            const unsuccessful = run.results.filter((result) => ['failed', 'broken'].includes(result.status));
            const screenshotsOf = (result) => (result.attachments || []).filter((attachment) => attachment.type === 'image/png');

            assert.equal(unsuccessful.length, 66);
            unsuccessful.forEach((result) => {
                assert.equal(screenshotsOf(result).length, 1, `${result.name} (${result.status})`);
                assert.ok(fs.existsSync(path.join(run.reportDir, 'allure-results', screenshotsOf(result)[0].source)), screenshotsOf(result)[0].name);
            });
            run.results.filter((result) => ['passed', 'skipped'].includes(result.status)).forEach((result) => assert.deepEqual(screenshotsOf(result), [], result.name));

            // a folder of screenshots for each spec file with failing attempts (the crashes may have left one too, which is not attached to anything)
            assert.deepEqual(
                fs.readdirSync(run.temp.file('screenshots')).filter((dir) => dir !== 'crashes-twice.cy.js').sort(),
                ['broken.cy.js', 'failures.cy.js', 'passes-after-spec-retry.cy.js', 'passes-after-test-retries.cy.js', 'retries.cy.js'],
            );

            const testCaseDir = path.join(run.reportDir, 'allure-report', 'data', 'test-cases');
            const testCases = fs.readdirSync(testCaseDir)
                .map((file) => fs.readJsonSync(path.join(testCaseDir, file)))
                .filter((testCase) => !testCase.hidden); // hidden test cases are the earlier attempts
            const shown = (fullName) => {
                const testCase = testCases.find((t) => titleOf(t.fullName) === fullName);
                return [testCase.status, testCase.retriesCount];
            };

            assert.equal(testCases.length, 24);

            // retries are the results other than the latest, from every attempt of every run
            assert.deepEqual(shown('Retries fails every attempt'), ['failed', 7]);
            assert.deepEqual(shown('Retries passes on the fourth attempt'), ['passed', 7]);
            assert.deepEqual(shown('Retries passes on the third attempt'), ['passed', 5]);
            assert.deepEqual(shown('Retries passes on the second attempt'), ['passed', 3]);
            assert.deepEqual(shown('Broken is broken on every attempt'), ['broken', 7]);
            assert.deepEqual(shown('Broken is broken by an unavailable environment'), ['broken', 7]);
            assert.deepEqual(shown('Failures throws an error'), ['broken', 7]);
            assert.deepEqual(shown('Failures fails an expect assertion'), ['failed', 7]);
            assert.deepEqual(shown('Spec retry only passes when the spec file is retried'), ['passed', 4]);
            assert.deepEqual(shown('Spec retry passes every time'), ['passed', 1]);
            assert.deepEqual(shown('Test retries is retried twice before it passes'), ['passed', 2]);
            assert.deepEqual(shown('Test retries passes first time'), ['passed', 0]);
            assert.deepEqual(shown('Crashes runs once Cypress stops crashing'), ['passed', 0]);
            assert.deepEqual(shown('Skipped skips itself at runtime'), ['skipped', 0]);
            assert.deepEqual(shown('Skipped a skipped suite is skipped with its suite 2'), ['skipped', 0]);
        } finally {
            fs.rmSync(markerDir, { recursive: true, force: true });
            run.cleanup();
        }
    });

    scenario('compares maxConcurrentThreads values with maxConcurrentThreadsExperiment (sync API)', async () => {
        const title = 'compares maxConcurrentThreads values with maxConcurrentThreadsExperiment (sync API)';

        const run = await runScenario(title, {
            phases: [{ specsDir: 'cypress/e2e/phase1' }],
            maxConcurrentThreadsExperiment: { maxConcurrentThreadsArray: [1, 2], repeat: 2 },
        }, { sync: true });

        const experiments = ['cmre_1_0', 'cmre_1_1', 'cmre_2_0', 'cmre_2_1'];
        const inReportDir = (...parts) => path.join(run.reportDir, ...parts);

        try {
            assert.equal(run.processExitCode, 0, run.output);
            assert.match(run.output, /Max concurrent threads experiment is active\.[\s\S]*Max concurrent threads array: 1,2\nEach experiment will run 2 time\(s\)/);

            // the whole suite ran 4 times, twice with each maxConcurrentThreads value
            assert.equal(run.output.match(/A maximum of 1 threads will be used at any one time/g).length, 2);
            assert.equal(run.output.match(/A maximum of 2 threads will be used at any one time/g).length, 2);

            // the results compare every experiment to the longest one
            const results = run.output.slice(run.output.indexOf(`Cypress Multithreaded Runner: ${title}\n\nMax concurrent threads experiment results:`));
            const resultLines = results.match(/^(\d max concurrent thread\(s\):|Experiment #\d: [█░]{50} \d+\.\d{2}% \(.+\))$/gm);

            assert.deepEqual(resultLines.map((line) => line.replace(/: [█░].*$/, '')), [
                '1 max concurrent thread(s):',
                'Experiment #1',
                'Experiment #2',
                '2 max concurrent thread(s):',
                'Experiment #1',
                'Experiment #2',
            ]);
            assert.ok(resultLines.some((line) => line.includes(' 100.00% ')), 'the longest experiment should be 100%');
            // Cypress occasionally fails to start (e.g. it can't connect to Electron). The runner restarts it, and the summary says so
            assert.equal(results.match(/^3 of 3 tests passed \(100%\)\. (?:\d+ threads? crashed \d+ times?\. )?1 test failed 1 time$/gm).length, 4);
            assert.match(results, /can be accessed at: ".*index\.html"/);

            // every run is archived with its own report
            assert.deepEqual(
                fs.readdirSync(run.reportDir).sort(),
                [...experiments.flatMap((dir) => [dir, `${dir}_allure-report`]), 'index.html'].sort(),
            );

            experiments.forEach((dir) => {
                assert.match(fs.readFileSync(inReportDir(dir, 'thread-performance-summary.txt'), 'utf8'), /^3 of 3 tests passed \(100%\)/, dir);
                assert.ok(fs.existsSync(inReportDir(dir, 'cypress-logs', 'thread_1.txt')), dir);
                assert.equal(readJsonSafe(inReportDir(`${dir}_allure-report`, 'widgets', 'summary.json')).statistic.total, 3, dir);
                assert.match(fs.readFileSync(inReportDir(`${dir}_allure-report`, 'complete.html'), 'utf8'), /id="cmr-run-config"/, dir);
            });

            // the results page links to every experiment's report
            const links = [...fs.readFileSync(inReportDir('index.html'), 'utf8').matchAll(/href="\.\/([^"]+)"/g)].map(([, href]) => href);

            assert.deepEqual(links, experiments.map((dir) => `${dir}_allure-report/complete.html`));
            links.forEach((href) => assert.ok(fs.existsSync(inReportDir(href)), href));

            // experiments never update the benchmark file
            assert.equal(run.benchmark, undefined);
        } finally {
            run.cleanup();
        }
    });

    scenario('applies grep options, which @cypress/grep receives via --expose', async () => {
        const run = await runScenario('applies grep options, which @cypress/grep receives via --expose', {
            phases: [{ specsDir: 'cypress/e2e/phase2', grepTags: '@slow' }],
        });

        try {
            assert.equal(run.exitCode, 0, run.output);
            assert.match(run.output, /1 test found in 2 spec files/);

            const tagged = run.results.filter((result) => /^(Tagged|Untagged) /.test(titleOf(result.fullName)));
            assert.deepEqual(statuses(tagged), ['Tagged smoke and slow: passed', 'Tagged smoke only: skipped', 'Untagged no tags: skipped']);

            assert.equal(run.benchmark.successPercentage, 100);
            assert.equal(run.benchmark.tests.passed, 1);
        } finally {
            run.cleanup();
        }
    });

    scenario('links spec files in the report to the URL includeRepoPath gives, or doesn\'t link them when it\'s falsy', async () => {
        const title = 'links spec files in the report to the URL includeRepoPath gives, or doesn\'t link them when it\'s falsy';
        const baseUrl = 'https://git.example.com/acme/widgets/blob/abc123';
        const config = { phases: [{ specsDir: 'cypress/e2e/phase1' }] };

        const withUrl = await runScenario(`${title} (a URL)`, { ...config, includeRepoPath: `${baseUrl}/` });
        const falsy = await runScenario(`${title} (false)`, { ...config, includeRepoPath: false });

        // (node-html-parser doesn't parse inside <pre> by default, which a browser does, and the summary & logs are in <pre>s)
        const links = (html, selector) => parse(html, { blockTextElements: { script: true, noscript: true, style: true } })
            .querySelectorAll(`${selector} a.cmr-spec-link`)
            .map((a) => [a.getAttribute('href'), a.text]);

        // the URL is followed by the spec file's path within the repo (this one, as the fixture project is inside it)
        const linked = (spec) => [`${baseUrl}/test/fixtures/cypress-project/cypress/e2e/phase1/${spec}`, `cypress/e2e/phase1/${spec}`];

        try {
            assert.equal(withUrl.exitCode, 0, withUrl.output);
            assert.equal(falsy.exitCode, 0, falsy.output);

            ['allure-report/index.html', 'allure-report/complete.html'].forEach((file) => {
                const html = withUrl.readReportFile(file);

                // the header warns about flaky.cy.js (it needed a retry), and the footer has every thread's heading & the performance summary
                assert.deepEqual(links(html, '.cmr-header .cmr-warn'), [linked('flaky.cy.js')], file);
                assert.deepEqual(links(html, '.cmr-footer .cmr-pre-heading'), [linked('flaky.cy.js'), linked('pass.cy.js')], file);
                assert.deepEqual(links(html, '.cmr-footer .cmr-report pre'), [linked('flaky.cy.js'), linked('pass.cy.js')], file);

                // the logs are left as Cypress printed them
                assert.deepEqual(links(html, '.cmr-thread-pre'), [], file);

                // when it's falsy, the spec files are only named
                const unlinked = falsy.readReportFile(file);

                assert.doesNotMatch(unlinked, /cmr-spec-link"/, file);
                assert.match(unlinked, /Thread #1 \[cypress&#x2F;e2e&#x2F;phase1&#x2F;flaky\.cy\.js\]/, file);
            });
        } finally {
            withUrl.cleanup();
            falsy.cleanup();
        }
    });
});
