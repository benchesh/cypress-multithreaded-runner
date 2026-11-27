const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { buildThreadReport, describeFailCounts } = require('../../lib/report/threadReport');
const benchmark = require('../../lib/report/benchmark');
const { resolveCustomLogs } = require('../../lib/report/customLogs');
const { toBrowserStackXml } = require('../../lib/report/junit');
const { buildReportHeader, buildReportFooter, injectIntoReport } = require('../../lib/allure/html/reportHtml');
const { Thread, Outcome } = require('../../lib/threads/Thread');
const { normaliseSettings } = require('../../lib/config/settings');
const { computeTestStats } = require('../../lib/report/testOutcomes');
const { createTempDir } = require('../helpers/tempDir');
const { keepFiles } = require('../helpers/artifacts');

const keep = (name, files) => keepFiles({ kind: 'unit', suite: 'reports', name }, files);

const settings = normaliseSettings({
    phases: [{ specsDir: 'one' }, { specsDir: 'two' }],
    threadTimeLimit: 60,
});

const thread = (threadNo, phaseNo, outcome, extra = {}) => Object.assign(
    new Thread({ threadNo, phase: settings.phases[phaseNo - 1], spec: `spec${threadNo}.cy.js` }),
    { outcome, secs: 10, hasResults: true },
    extra,
);

const test = (status, extra = {}) => ({ fullTitle: 'x', status, failedAttempts: 0, origin: 'result', ...extra });

describe('buildThreadReport', () => {
    it('gives each thread a status, heading and summary', () => {
        const threads = [
            thread(1, 1, Outcome.PASSED),
            thread(2, 1, Outcome.PASSED, { restarts: 1 }),
            thread(3, 1, Outcome.FAILED),
            thread(4, 1, Outcome.TIMED_OUT, { secs: 60 }),
            thread(5, 2, Outcome.NOT_RUN, { secs: undefined, hasResults: false }),
        ];

        const threadOutcomes = new Map([
            [1, { tests: [test('passed')] }],
            [2, { tests: [test('passed', { failedAttempts: 2 })] }],
            [3, { tests: [test('failed', { failedAttempts: 1 })] }],
            [4, { tests: [test('passed'), test('broken', { origin: 'filled' })] }],
            [5, { tests: [test('failed', { origin: 'filled', notRun: true })] }],
        ]);

        const testStats = computeTestStats([...threadOutcomes.values()].flatMap((o) => o.tests));

        const { entries, summary, reportText } = buildThreadReport({
            threads,
            threadOutcomes,
            settings,
            isPhaseSkipped: () => false,
            testStats,
        });

        assert.deepEqual([...entries.values()].map((entry) => entry.status), ['success', 'warn', 'error', 'error', 'error']);

        assert.deepEqual(entries.get(2).heading, [
            'Thread #2 [spec2.cy.js]',
            'WARNING: 1 test failed 2 times and the thread needed restarting 1 time',
        ]);
        assert.equal(entries.get(4).heading[1], 'CRITICAL ERROR: Thread did not complete as it went over the time limit of 1 minute');
        assert.match(entries.get(4).heading[2], /1 test didn't produce a result, so it has been added to the Allure report as broken/);
        assert.equal(entries.get(5).heading[1], 'ERROR: Thread did not run because a thread in an earlier phase failed');
        assert.match(entries.get(5).summary, /1 test didn't run, so it has been added to the Allure report as failed/);

        assert.match(summary, /^3 of 6 tests passed \(50%\)/);
        assert.match(summary, /1 thread didn't complete due to timing out/);
        assert.match(summary, /1 thread didn't complete because a thread in an earlier phase failed/);
        assert.match(summary, /1 thread crashed 1 time/);
        assert.match(summary, /2 tests didn't produce a result and have been filled in/);

        assert.match(reportText, /\[PHASE #1\]\n\nThread #1 \[spec1\.cy\.js\]\n█{8}░{42} 16\.67% \(10 seconds\)/);
        assert.match(reportText, /relative to thread #4, which was the longest at 1 minute/);

        keep('thread report', {
            'summary.txt': summary,
            'thread-performance-report.txt': reportText,
            'thread-entries.json': Object.fromEntries(entries),
            'test-stats.json': testStats,
        });
    });

    it('describes each attempt of a retried thread separately', () => {
        const retried = (threadNo, phaseNo, previousAttempts, extra = {}) => thread(threadNo, phaseNo, Outcome.PASSED, { previousAttempts, attempts: previousAttempts.length + 1, ...extra });

        const threads = [
            // crashed once and failed, then passed when retried
            retried(1, 1, [{ outcome: Outcome.FAILED, restarts: 1 }]),
            // phase 2 didn't run because thread #1 failed, so was retried with it
            retried(2, 2, [{ outcome: Outcome.NOT_RUN, restarts: 0 }]),
            // then this one failed in the retry, so was retried again, needing restarting this time
            retried(3, 2, [{ outcome: Outcome.NOT_RUN, restarts: 0 }, { outcome: Outcome.FAILED, restarts: 0 }], { restarts: 2 }),
            // never retried, so nothing changes
            thread(4, 1, Outcome.PASSED),
        ];

        const threadOutcomes = new Map([
            [1, { tests: [test('passed', { failedAttempts: 3, failedAttemptsByThreadAttempt: [2, 1] }), test('passed', { failedAttemptsByThreadAttempt: [1, 0] })] }],
            [2, { tests: [test('passed', { failedAttemptsByThreadAttempt: [0, 0] })] }],
            [3, { tests: [test('passed', { failedAttempts: 1, failedAttemptsByThreadAttempt: [0, 1, 0] })] }],
            [4, { tests: [test('passed', { failedAttempts: 1, failedAttemptsByThreadAttempt: [1] })] }],
        ]);

        const { entries, summary } = buildThreadReport({
            threads,
            threadOutcomes,
            settings,
            isPhaseSkipped: () => false,
            testStats: computeTestStats([...threadOutcomes.values()].flatMap((o) => o.tests)),
        });

        // (entries are in phase order, so they're looked up by thread number)
        assert.deepEqual([1, 2, 3, 4].map((threadNo) => entries.get(threadNo).status), ['warn', 'warn', 'warn', 'warn']);
        assert.deepEqual([1, 2, 3, 4].map((threadNo) => entries.get(threadNo).heading), [
            [
                'Thread #1 [spec1.cy.js] (2 attempts)',
                'WARNING: In the first attempt: 1 test failed 2 times, 1 test failed 1 time, the thread needed restarting 1 time and the spec file failed. In the second attempt: 1 test failed 1 time and the spec file passed',
            ],
            [
                'Thread #2 [spec2.cy.js] (2 attempts)',
                'WARNING: In the first attempt: the thread didn\'t run because a thread in an earlier phase failed. In the second attempt: the spec file passed',
            ],
            [
                'Thread #3 [spec3.cy.js] (3 attempts)',
                'WARNING: In the first attempt: the thread didn\'t run because a thread in an earlier phase failed. In the second attempt: 1 test failed 1 time and the spec file failed. In the third attempt: the thread needed restarting 2 times and the spec file passed',
            ],
            ['Thread #4 [spec4.cy.js]', 'WARNING: 1 test failed 1 time'],
        ]);
        assert.match(summary, /2 threads failed and had to be retried\. 2 threads were retried because a thread in an earlier phase failed/);
    });

    it('describes the attempts of a thread that never recovered, followed by the tests that were filled in', () => {
        const crashed = thread(1, 1, Outcome.CRASHED, {
            previousAttempts: [{ outcome: Outcome.TIMED_OUT, restarts: 0 }],
            attempts: 2,
            restarts: 6,
            hasResults: false,
        });

        const { entries } = buildThreadReport({
            threads: [crashed],
            threadOutcomes: new Map([[1, { tests: [test('broken', { origin: 'filled' }), test('broken', { origin: 'filled' })] }]]),
            settings,
            isPhaseSkipped: () => false,
            testStats: computeTestStats([]),
        });

        assert.deepEqual(entries.get(1).heading, [
            'Thread #1 [spec1.cy.js] (2 attempts)',
            'CRITICAL ERROR: Thread did not complete!',
            'WARNING: In the first attempt: the thread went over the time limit of 1 minute. In the second attempt: the thread crashed 6 times, never recovering. 2 tests didn\'t produce a result, so they have been added to the Allure report as broken',
        ]);
    });

    it('reports "No tests failed!" when everything passed', () => {
        const threads = [thread(1, 1, Outcome.PASSED)];
        const threadOutcomes = new Map([[1, { tests: [test('passed')] }]]);

        const { summary } = buildThreadReport({
            threads,
            threadOutcomes,
            settings,
            isPhaseSkipped: (phaseNo) => phaseNo === 2,
            testStats: computeTestStats([test('passed')]),
        });

        assert.equal(summary, '1 of 1 test passed (100%). No tests failed!');
    });

    it('describeFailCounts groups tests by how many times they failed', () => {
        assert.deepEqual(describeFailCounts([0, 1, 1, 3]), ['1 test failed 3 times', '2 tests failed 1 time']);
    });
});

describe('benchmark', () => {
    it('builds an identity that does not change between runs', () => {
        const phaseSettings = normaliseSettings({ phases: [{ specsDir: 'one', grep: 'login', onlyRunSpecFilesIncludingAnyText: 'x' }] });
        const identity = benchmark.benchmarkIdentity(phaseSettings, null);

        assert.deepEqual(identity, {
            phases: [{
                specsDir: 'one',
                onlyRunSpecFilesIncludingAnyText: ['x'],
                additionalCypressEnvArgs: ',grep="login"',
            }],
        });
        assert.equal(benchmark.benchmarkId(phaseSettings, identity), btoa(JSON.stringify(identity)));
        assert.equal(benchmark.benchmarkId({ ...phaseSettings, benchmarkDescription: 'mine' }, identity), 'mine');
        assert.doesNotThrow(() => benchmark.benchmarkId(phaseSettings, { emoji: '🚀' }));
    });

    it('orders slowest first, keeping the previous order when phases did not complete', () => {
        const threads = [
            Object.assign(thread(1, 1, Outcome.PASSED), { spec: 'fast.cy.js', secs: 5 }),
            Object.assign(thread(2, 1, Outcome.FAILED), { spec: 'slow.cy.js', secs: 50 }),
        ];

        const testStats = computeTestStats([test('passed'), test('failed')]);

        const { record, orderChanged, orderReason } = benchmark.buildBenchmarkRecord({
            identity: { phases: [] },
            previous: { order: ['fast.cy.js', 'slow.cy.js'] },
            threads,
            failedSpecs: ['slow.cy.js', 'slow.cy.js'],
            testStats,
            timestamp: 123,
            customMetadata: { build: 1 },
        });

        keep('benchmark record', { 'benchmark-record.json': record });

        assert.deepEqual(record.order, ['slow.cy.js', 'fast.cy.js']);
        assert.deepEqual(record.fails, ['slow.cy.js']);
        assert.equal(record.successPercentage, 50);
        assert.deepEqual(record.customMetadata, { build: 1 });
        assert.equal(record.tests.total, 2);
        assert.equal(orderChanged, true);
        assert.equal(orderReason, null);

        threads.push(thread(3, 2, Outcome.NOT_RUN));
        const incomplete = benchmark.buildBenchmarkRecord({ identity: {}, previous: { order: ['a'] }, threads, failedSpecs: [], testStats, timestamp: 1 });

        assert.deepEqual(incomplete.record.order, ['a']);
        assert.match(incomplete.orderReason, /phases did not complete/);
    });

    it('orders spec files using a saved order', () => {
        assert.deepEqual(benchmark.orderSpecsByBenchmark(['a', 'b', 'c'], ['c', 'a', 'c', 'gone']), ['b', 'c', 'a']);
        assert.deepEqual(benchmark.orderSpecsByBenchmark(['a', 'b'], undefined), ['a', 'b']);
    });

    it('saves benchmarks alongside existing ones', () => {
        const temp = createTempDir({ 'bench.json': { other: { order: [] } } });
        const file = temp.file('bench.json');

        benchmark.saveBenchmark(file, benchmark.loadBenchmarks(file), 'mine', { order: ['x'] });

        assert.deepEqual(fs.readJsonSync(file), { other: { order: [] }, mine: { order: ['x'] } });
        assert.deepEqual(benchmark.loadBenchmarks(temp.file('missing.json')), {});
        temp.cleanup();
    });
});

describe('resolveCustomLogs', () => {
    it('combines content with generated content, and survives errors', () => {
        assert.deepEqual(resolveCustomLogs([
            { heading: 'A', content: 'static' },
            { content: 'static', generateContent: () => 'dynamic' },
            { generateContent: () => { throw new Error('boom'); } },
        ]), [
            { heading: 'A', content: 'static' },
            { heading: 'Custom Logs 2', content: 'static\n\ndynamic' },
            { heading: 'Custom Logs 3', content: 'ERROR: Failed to generate customLogs[2] content; please check the generateContent function: boom' },
        ]);
    });
});

describe('toBrowserStackXml', () => {
    it('removes timestamps and sanitises names', () => {
        assert.equal(
            toBrowserStackXml('<testcase name="a/b é" timestamp="2024" time="1">'),
            '<testcase name="a-b -" time="1">',
        );
    });
});

describe('Allure report HTML', () => {
    it('injects the header and footer, embedding the run config', () => {
        const temp = createTempDir({ 'index.html': '<html><body><div id="content"></div></body></html>' });
        const t = thread(1, 1, Outcome.PASSED);
        t.addTimestampedLog('<script>alert(1)</script> $& log');

        const header = buildReportHeader({
            heading: 'Cypress Multithreaded Runner: Nightly',
            status: 'error',
            runConfig: { fails: ['a.cy.js'], summary: '</script> sneaky' },
            criticalHtml: 'Threads crashed',
            errors: ['ERROR: thread 1'],
            warnings: [],
            notes: ['a note'],
            browserStackObservabilityURL: 'https://example.com/report',
            timestamp: 1,
        });

        const footer = buildReportFooter({
            customLogs: [{ heading: 'Custom', content: '<b>html allowed</b>' }],
            threads: [{ status: 'success', heading: ['Thread #1 [a.cy.js]'], logsTimestamped: t.logsTimestamped }],
            performanceSummary: 'summary',
            expandHeader: true,
        });

        injectIntoReport(temp.file('index.html'), header, footer);
        const html = fs.readFileSync(temp.file('index.html'), 'utf8');

        // open index.html in a browser to see the header and footer the runner adds to an Allure report
        keep('injected report html', { 'index.html': html });

        assert.match(html, /<script type="application\/json" id="cmr-run-config">/);
        assert.match(html, /\[CRITICAL ERRORS - PLEASE READ\]/);
        assert.match(html, /View the BrowserStack Test Observability report here/);
        assert.match(html, /&lt;script&gt;alert\(1\)&lt;&#x2F;script&gt; \$&amp; log/);
        assert.match(html, /<b>html allowed<\/b>/);
        assert.match(html, /"expandHeader":true/);
        assert.match(html, /<div id="content"><\/div>/);

        // the embedded config must still be readable by runFailedSpecFilesFromReportURL
        const { parseFailsFromReport } = require('../../lib/specs/specSelection');
        assert.deepEqual(parseFailsFromReport(html), ['a.cy.js']);

        temp.cleanup();
    });

    it('ships the client script and styles', () => {
        const footer = buildReportFooter({ customLogs: [], threads: [], performanceSummary: '', expandHeader: false });

        assert.match(footer, /\.cmr-content \{/);
        assert.match(footer, /cmr-take-screenshot/);
        assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(__dirname, '../../lib/allure/html/client.js'), 'utf8')));
    });
});
