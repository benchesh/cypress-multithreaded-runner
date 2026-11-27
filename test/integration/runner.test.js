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

const TIMEOUT = 5 * 60 * 1000;

const statuses = (results) => results.map((result) => `${result.fullName}: ${result.status}`).sort();

describe('runner (real Cypress)', { timeout: TIMEOUT }, () => {
    it('runs every phase, counting every test up front (sync API)', async () => {
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
            assert.match(run.readReportFile('thread-performance-summary.txt'), /^11 of 11 tests passed \(100%\), with 1 skipped\. 1 test failed at least 1 time$/);
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

    it('stops subsequent phases when a test fails, adding their tests to the report as failed', async () => {
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
            assert.match(run.readReportFile('thread-performance-summary.txt'), /1 test failed at least 4 times/);
            assert.match(run.reportHtml, /phase #1 failed/);
            assert.match(run.reportHtml, /didn't produce results have been added to this report \(3 as failed\)/);
        } finally {
            run.cleanup();
        }
    });

    it('fills in the tests a timed out thread never reached, so the report has every test', async () => {
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

    it('restarts a crashing thread up to maxThreadRestarts times', async () => {
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

    it('only re-runs previously failed spec files, treating the rest as passed', async () => {
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

    it('retries failed spec files with retryAllFailedSpecs, keeping every attempt in the report', async () => {
        const marker = require('path').join(require('os').tmpdir(), `cmr-retry-marker-${Date.now()}`);

        const run = await runScenario('retries failed spec files with retryAllFailedSpecs, keeping every attempt in the report', {
            phases: [{ specsDir: 'cypress/e2e/retry', passthroughEnvArgs: `retryMarker=${marker}` }],
            retryAllFailedSpecs: 2,
            retryAllFailedSpecsDelay: 1,
        });

        try {
            assert.equal(run.exitCode, 0, run.output);
            assert.match(run.output, /1 thread failed. Retry attempt 1 of 2 will begin in 1 second/);
            assert.doesNotMatch(run.output, /Retry attempt 2 of 2/);

            // Allure shows the final attempt, with the failed attempt as a retry
            assert.deepEqual(run.allureStatistic, { failed: 0, broken: 0, skipped: 0, passed: 2, unknown: 0, total: 2 });
            assert.equal(run.results.filter((result) => result.name === 'fails on the first run only').length, 2);
            assert.equal(run.benchmark.successPercentage, 100);
            assert.deepEqual(run.benchmark.fails, []);

            assert.match(run.readReportFile('cypress-logs/thread_1.txt'), /Retry attempt 1 of thread #1/);
            assert.match(run.readReportFile('thread-performance-summary.txt'), /1 thread failed and had to be retried/);
        } finally {
            require('fs').rmSync(marker, { force: true });
            run.cleanup();
        }
    });

    it('keeps Allure history between runs, so the report shows trends and each test\'s previous results', async () => {
        const title = 'keeps Allure history between runs, so the report shows trends and each test\'s previous results';
        const marker = path.join(os.tmpdir(), `cmr-history-marker-${Date.now()}`);
        const historyTemp = createTempDir();
        const runs = [];

        // 'fails on the first run only' fails in run 1 and passes in runs 2 & 3; fail.cy.js's 'fails' always fails
        const config = {
            phases: [
                { specsDir: 'cypress/e2e/retry', passthroughEnvArgs: `retryMarker=${marker}` },
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
            const previousStatuses = (fullName) => testCases.find((testCase) => testCase.fullName === fullName).extra.history.items.map((item) => item.status);

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
            fs.rmSync(marker, { force: true });
            historyTemp.cleanup();
        }
    });

    it('reports a mix of passed, failed, broken, skipped and retried tests', async () => {
        const run = await runScenario('reports a mix of passed, failed, broken, skipped and retried tests', {
            phases: [{ specsDir: 'cypress/e2e/mixed' }],
            maxConcurrentThreads: 4,
        });

        try {
            assert.equal(run.exitCode, 1, run.output);
            assert.match(run.output, /17 tests found in 4 spec files/);

            assert.deepEqual(run.allureStatistic, { failed: 4, broken: 2, skipped: 6, passed: 5, unknown: 0, total: 17 });
            assert.deepEqual(generatedResults(run.results), []);

            // 5 passed out of 11 (17 tests, minus the 6 that were skipped)
            assert.equal(run.benchmark.successPercentage, 45.45);
            assert.deepEqual(run.benchmark.fails.sort(), [
                'cypress/e2e/mixed/broken.cy.js',
                'cypress/e2e/mixed/failures.cy.js',
                'cypress/e2e/mixed/retries.cy.js',
            ]);

            // Cypress retried these tests 3 times (4 attempts)
            assert.match(run.output, /\(Attempt 3 of 4\) fails every attempt/);
            assert.match(run.output, /\(Attempt 3 of 4\) passes on the fourth attempt/);
            assert.match(run.output, /\(Attempt 3 of 4\) is broken on every attempt/);
            assert.doesNotMatch(run.output, /\(Attempt 2 of 4\) passes on the second attempt/);

            assert.equal(
                run.readReportFile('thread-performance-summary.txt'),
                '5 of 11 tests passed (45.45%), with 6 skipped. 2 tests failed at least 4 times, 1 test failed at least 3 times and 5 tests failed at least 1 time',
            );
            assert.match(run.readReportFile('thread-performance-report.txt'), /Thread #3 \[cypress\/e2e\/mixed\/retries\.cy\.js\]\n.*\(WARNING: 1 test failed at least 4 times, 1 test failed at least 3 times and 1 test failed at least 1 time\)/);

            // every attempt is kept, and Allure shows each test once with its earlier attempts as retries
            const attemptsOf = (name) => run.results.filter((result) => result.name === name).map((result) => result.status);
            assert.deepEqual(attemptsOf('fails every attempt'), ['failed', 'failed', 'failed', 'failed']);
            assert.deepEqual(attemptsOf('passes on the fourth attempt').sort(), ['failed', 'failed', 'failed', 'passed']);
            assert.deepEqual(attemptsOf('is broken on every attempt'), ['broken', 'broken', 'broken', 'broken']);

            const testCaseDir = path.join(run.reportDir, 'allure-report', 'data', 'test-cases');
            const testCases = fs.readdirSync(testCaseDir)
                .map((file) => fs.readJsonSync(path.join(testCaseDir, file)))
                .filter((testCase) => !testCase.hidden); // hidden test cases are the earlier attempts
            const shown = (fullName) => {
                const testCase = testCases.find((t) => t.fullName === fullName);
                return [testCase.status, testCase.retriesCount];
            };

            assert.equal(testCases.length, 17);
            assert.deepEqual(shown('Retries fails every attempt'), ['failed', 3]);
            assert.deepEqual(shown('Retries passes on the fourth attempt'), ['passed', 3]);
            assert.deepEqual(shown('Retries passes on the second attempt'), ['passed', 1]);
            assert.deepEqual(shown('Broken is broken on every attempt'), ['broken', 3]);
            assert.deepEqual(shown('Broken is broken by an unavailable environment'), ['broken', 0]);
            assert.deepEqual(shown('Failures throws an error'), ['failed', 0]);
            assert.deepEqual(shown('Skipped skips itself at runtime'), ['skipped', 0]);
            assert.deepEqual(shown('Skipped a skipped suite is skipped with its suite 2'), ['skipped', 0]);
        } finally {
            run.cleanup();
        }
    });

    it('compares maxConcurrentThreads values with maxConcurrentThreadsExperiment (sync API)', async () => {
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
            assert.equal(results.match(/^3 of 3 tests passed \(100%\)\. 1 test failed at least 1 time$/gm).length, 4);
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

    it('applies grep options, which @cypress/grep receives via --expose', async () => {
        const run = await runScenario('applies grep options, which @cypress/grep receives via --expose', {
            phases: [{ specsDir: 'cypress/e2e/phase2', grepTags: '@slow' }],
        });

        try {
            assert.equal(run.exitCode, 0, run.output);
            assert.match(run.output, /1 test found in 2 spec files/);

            const tagged = run.results.filter((result) => result.fullName.startsWith('Tagged') || result.fullName.startsWith('Untagged'));
            assert.deepEqual(statuses(tagged), ['Tagged smoke and slow: passed', 'Tagged smoke only: skipped', 'Untagged no tags: skipped']);

            assert.equal(run.benchmark.successPercentage, 100);
            assert.equal(run.benchmark.tests.passed, 1);
        } finally {
            run.cleanup();
        }
    });
});
