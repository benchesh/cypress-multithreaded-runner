const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const { ThreadPool } = require('../../lib/threads/ThreadPool');
const { runWithRetries } = require('../../lib/threads/runWithRetries');
const { LogPrinter } = require('../../lib/threads/LogPrinter');
const { Thread, Outcome } = require('../../lib/threads/Thread');
const { normaliseSettings } = require('../../lib/config/settings');
const { createFakeFactory, scripts, OUTPUT } = require('../helpers/fakeCypress');
const { createTempDir } = require('../helpers/tempDir');

const createThreads = (phaseNos) => phaseNos.map((phaseNo, index) => new Thread({ threadNo: index + 1, phase: { phaseNo }, spec: `spec${index + 1}.cy.js` }));

const createPool = ({ behaviour, config = {}, phaseCount = 2, crashLogsInResults = () => null }) => {
    const settings = normaliseSettings({
        threadDelay: 0,
        maxConcurrentThreads: 4,
        threadInactivityTimeout: 0,
        threadTimeLimit: 0,
        maxThreadRestarts: 2,
        ...config,
    });

    const fake = createFakeFactory(behaviour);
    const cleared = [];
    const completed = [];
    const warnings = [];

    const pool = new ThreadPool({
        settings,
        phaseCount,
        processFactory: fake.factory,
        printer: new LogPrinter({ logMode: 3, write: () => { }, log: () => { } }),
        resultsStore: {
            findCrashLogs: crashLogsInResults,
            clear: (thread) => cleared.push(thread.threadNo),
        },
        onThreadComplete: (thread) => completed.push(thread.threadNo),
        warn: (msg) => warnings.push(msg),
    });

    return { pool, fake, cleared, completed, warnings };
};

const outcomes = (threads) => threads.map((thread) => thread.outcome);

describe('ThreadPool', () => {
    it('runs every thread and records whether it passed or failed', async () => {
        const threads = createThreads([1, 1, 1]);
        const { pool, completed } = createPool({ behaviour: (thread) => (thread.threadNo === 2 ? scripts.fail() : scripts.pass()), phaseCount: 1 });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.PASSED, Outcome.FAILED, Outcome.PASSED]);
        assert.deepEqual(completed.sort(), [1, 2, 3]);
        assert.ok(threads.every((thread) => thread.complete && thread.secs !== undefined));
        assert.match(threads[0].logs, /Start of thread #1/);
    });

    it('never runs more than maxConcurrentThreads at once', async () => {
        const threads = createThreads([1, 1, 1, 1, 1, 1]);
        const { pool, fake } = createPool({ behaviour: () => scripts.pass(30), config: { maxConcurrentThreads: 2 }, phaseCount: 1 });

        await pool.run(threads);

        assert.equal(fake.maxRunning, 2);
        assert.ok(threads.every((thread) => thread.outcome === Outcome.PASSED));
    });

    it('waits threadDelay before starting the next thread, unless the current one starts running sooner', async () => {
        const slowStart = [{ wait: 300 }, ...scripts.pass()];
        const { pool, fake } = createPool({ behaviour: () => slowStart, config: { threadDelay: 0.1 }, phaseCount: 1 });

        await pool.run(createThreads([1, 1]));
        const gap = fake.spawns[1].at - fake.spawns[0].at;
        assert.ok(gap >= 90 && gap < 280, `expected the delay to be ~100ms, was ${gap}ms`);

        const quickStart = createPool({ behaviour: () => scripts.pass(), config: { threadDelay: 10 }, phaseCount: 1 });
        await quickStart.pool.run(createThreads([1, 1]));
        assert.ok(quickStart.fake.spawns[1].at - quickStart.fake.spawns[0].at < 1000, 'the delay should end once the first thread starts running');
    });

    it('restarts a thread when Cypress crashes, clearing its results', async () => {
        const threads = createThreads([1]);
        const { pool, fake, cleared, warnings } = createPool({ behaviour: (thread, spawnCount) => (spawnCount === 0 ? scripts.crash() : scripts.pass()), phaseCount: 1 });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.PASSED);
        assert.equal(threads[0].restarts, 1);
        assert.equal(fake.spawnsFor(1), 2);
        assert.deepEqual(cleared, [1]);
        assert.match(warnings[0], /Internal Cypress error in thread #1! Restarting it \(restart 1 of a maximum of 2\)/);
    });

    it('treats a run that never finishes as a crash', async () => {
        const threads = createThreads([1]);
        const { pool, fake } = createPool({ behaviour: (thread, spawnCount) => (spawnCount === 0 ? scripts.exitWithoutFinishing() : scripts.pass()), phaseCount: 1 });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.PASSED);
        assert.equal(fake.spawnsFor(1), 2);
    });

    it('treats crash messages in the Allure results as a crash', async () => {
        const threads = createThreads([1]);
        let checks = 0;
        const { pool, fake, warnings } = createPool({
            behaviour: () => scripts.pass(),
            phaseCount: 1,
            crashLogsInResults: () => (checks++ === 0 ? '/results/1/abc-result.json' : null),
        });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.PASSED);
        assert.equal(fake.spawnsFor(1), 2);
        assert.equal(warnings[0], 'Illegal log detected in Allure result file "/results/1/abc-result.json" for thread #1');
        assert.match(threads[0].logsTimestamped.map(([, log]) => log).join(''), /Illegal log detected in Allure result file/);
    });

    it('restarts a thread when its output contains one of the crashPatterns', async () => {
        const threads = createThreads([1]);
        const { pool, fake, warnings } = createPool({
            behaviour: (thread, spawnCount) => (spawnCount === 0
                ? [{ output: OUTPUT.start }, { output: 'FATAL: the disk is full\n' }, { hang: true }]
                : scripts.pass()),
            config: { crashPatterns: ['The Disk Is Full'] },
            phaseCount: 1,
        });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.PASSED);
        assert.equal(threads[0].restarts, 1);
        assert.equal(fake.spawnsFor(1), 2);
        assert.match(warnings[0], /Internal Cypress error in thread #1! Restarting it/);
    });

    it('does not treat the default crash patterns as crashes once crashPatterns replaces them', async () => {
        const threads = createThreads([1]);

        // Cypress prints a message that's normally a crash, but still finishes its run
        const { pool, fake, warnings } = createPool({
            behaviour: () => [{ output: OUTPUT.start }, { output: OUTPUT.crash }, { output: OUTPUT.fail }],
            config: { crashPatterns: ['the disk is full'] },
            phaseCount: 1,
        });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.FAILED);
        assert.equal(threads[0].restarts, 0);
        assert.equal(fake.spawnsFor(1), 1);
        assert.deepEqual(warnings, []);
    });

    it('gives up after maxThreadRestarts restarts', async () => {
        const threads = createThreads([1]);
        const { pool, fake, warnings } = createPool({ behaviour: () => scripts.crash(), phaseCount: 1 });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.CRASHED);
        assert.equal(threads[0].restarts, 3);
        assert.equal(fake.spawnsFor(1), 3); // the first run + 2 restarts
        assert.match(warnings.at(-1), /Giving up after 2 restarts/);
    });

    it('restarts a thread that stops responding (threadInactivityTimeout)', async () => {
        const threads = createThreads([1]);
        const { pool, fake, warnings } = createPool({
            behaviour: (thread, spawnCount) => (spawnCount === 0 ? scripts.hang() : scripts.pass()),
            config: { threadInactivityTimeout: 0.1 },
            phaseCount: 1,
        });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.PASSED);
        assert.equal(fake.spawnsFor(1), 2);
        assert.match(warnings[0], /hasn't responded/);
    });

    it('stops a thread that goes over threadTimeLimit, without restarting it', async () => {
        const threads = createThreads([1, 1]);
        const { pool, fake, warnings } = createPool({
            behaviour: (thread) => (thread.threadNo === 1 ? scripts.hang() : scripts.pass()),
            config: { threadTimeLimit: 0.15 },
            phaseCount: 1,
        });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.TIMED_OUT, Outcome.PASSED]);
        assert.equal(fake.spawnsFor(1), 1);
        assert.equal(pool.timeoutCount, 1);
        assert.match(warnings[0], /failed to complete within the maximum time limit/);
    });

    it('stops every thread when more than maxAllowedTimeouts threads time out', async () => {
        const threads = createThreads([1, 1, 1, 1]);
        const { pool } = createPool({
            behaviour: (thread) => (thread.threadNo <= 2 ? scripts.hang() : [{ wait: 1000 }, ...scripts.pass()]),
            config: { threadTimeLimit: 0.15, maxAllowedTimeouts: 1 },
            phaseCount: 1,
        });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.TIMED_OUT, Outcome.TIMED_OUT, Outcome.ABORTED, Outcome.ABORTED]);
        assert.equal(threads[2].secs, undefined);
    });

    it('stops threads in subsequent phases when a thread fails (stopSubsequentPhasesOnFail)', async () => {
        const threads = createThreads([1, 2, 2, 3]);
        const { pool, warnings } = createPool({
            behaviour: (thread) => {
                if (thread.threadNo === 1) return scripts.fail(50);
                if (thread.threadNo === 2) return scripts.hang();
                return scripts.pass();
            },
            config: { maxConcurrentThreads: 2 },
            phaseCount: 3,
        });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.FAILED, Outcome.STOPPED, Outcome.NOT_RUN, Outcome.NOT_RUN]);
        assert.equal(pool.phaseLock, 1);
        assert.match(warnings.join('\n'), /all threads from following phases will be stopped immediately/);
    });

    it('keeps running subsequent phases when stopSubsequentPhasesOnFail is false', async () => {
        const threads = createThreads([1, 2]);
        const { pool } = createPool({
            behaviour: (thread) => (thread.threadNo === 1 ? scripts.fail() : scripts.pass()),
            config: { stopSubsequentPhasesOnFail: false },
        });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.FAILED, Outcome.PASSED]);
    });

    it('does not stop anything when a thread in the last phase fails', async () => {
        const threads = createThreads([1, 2, 2]);
        const { pool } = createPool({ behaviour: (thread) => (thread.threadNo === 2 ? scripts.fail() : scripts.pass(50)) });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.PASSED, Outcome.FAILED, Outcome.PASSED]);
    });

    it('detects missing spec files without restarting', async () => {
        const threads = createThreads([1]);
        const { pool, fake } = createPool({ behaviour: () => scripts.noSpecs(), phaseCount: 1 });

        await pool.run(threads);

        assert.equal(threads[0].outcome, Outcome.NO_SPECS);
        assert.equal(fake.spawnsFor(1), 1);
    });

    it('waits for the waitForFileExist file before starting the second thread', async () => {
        const temp = createTempDir();
        const filepath = temp.file('cookies.json');

        const threads = createThreads([1, 1]);
        const { pool, fake } = createPool({
            behaviour: (thread) => (thread.threadNo === 1 ? [{ output: '(Run Starting)\n' }, { wait: 1000 }, { output: '(Run Finished)\nAll specs passed!' }] : scripts.pass()),
            config: { threadDelay: 0, waitForFileExist: { filepath, timeout: 10 } },
            phaseCount: 1,
        });

        setTimeout(() => fs.writeFileSync(filepath, '{"a":1}'), 300);

        await pool.run(threads);
        temp.cleanup();

        const gap = fake.spawns[1].at - fake.spawns[0].at;
        assert.ok(gap >= 290 && gap < 1000, `expected the second thread to wait for the file (~300ms), waited ${gap}ms`);
    });

    it('stops waiting for the waitForFileExist file when the first thread completes', async () => {
        const threads = createThreads([1, 1]);
        const { pool, warnings } = createPool({
            behaviour: () => scripts.pass(10),
            config: { waitForFileExist: { filepath: '/does/not/exist', timeout: 10 } },
            phaseCount: 1,
        });

        await pool.run(threads);

        assert.deepEqual(outcomes(threads), [Outcome.PASSED, Outcome.PASSED]);
        assert.match(warnings[0], /the first thread has completed but the "\/does\/not\/exist" file doesn't exist/);
        assert.match(threads[1].logsTimestamped.at(0)[1], /first thread has completed/);
    });
});

describe('runWithRetries', () => {
    it('retries failed threads (keeping their thread numbers) until they pass or retries run out', async () => {
        const threads = createThreads([1, 1, 1]);
        const { pool, fake } = createPool({
            behaviour: (thread) => {
                if (thread.threadNo === 2 && thread.attempts === 1) return scripts.fail();
                if (thread.threadNo === 3) return scripts.fail();
                return scripts.pass();
            },
            phaseCount: 1,
        });

        const waits = [];
        const logs = [];

        await runWithRetries({ pool, threads, retries: 2, retryDelay: 1.5, log: (msg) => logs.push(msg), wait: async (ms) => waits.push(ms) });

        assert.deepEqual(outcomes(threads), [Outcome.PASSED, Outcome.PASSED, Outcome.FAILED]);
        assert.deepEqual(threads.map((thread) => thread.attempts), [1, 2, 3]);
        assert.deepEqual([fake.spawnsFor(1), fake.spawnsFor(2), fake.spawnsFor(3)], [1, 2, 3]);
        assert.deepEqual(waits, [1500, 1500]);
        assert.match(logs[0], /2 threads failed. Retry attempt 1 of 2 will begin in 1.5 seconds/);
        assert.match(threads[1].fullLogs, /Start of thread #2:[\s\S]*Retry attempt 1 of thread #2[\s\S]*Start of thread #2:/);
        assert.doesNotMatch(threads[1].logs, /Retry attempt/);
    });

    it('retries threads that were stopped because an earlier phase failed, but not threads with no spec files', async () => {
        const threads = createThreads([1, 1, 2]);
        const { pool } = createPool({
            behaviour: (thread) => {
                if (thread.threadNo === 1) return thread.attempts === 1 ? scripts.fail() : scripts.pass();
                if (thread.threadNo === 2) return scripts.noSpecs();
                return scripts.pass();
            },
            config: { maxConcurrentThreads: 1 },
        });

        const logs = [];

        // first run: #1 fails, #2 has no spec files, #3 (phase 2) never runs
        await runWithRetries({ pool, threads, retries: 1, retryDelay: 0, log: (msg) => logs.push(msg) });

        // #3 is retried because it was stopped, not because it failed
        assert.ok(logs[0].includes('1 thread failed and 1 thread was stopped because a thread in an earlier phase failed. Retry attempt 1 of 1 will begin:\nThread #1: "spec1.cy.js"\nThread #3: "spec3.cy.js" (didn\'t run)\n'), logs[0]);
        assert.deepEqual(outcomes(threads), [Outcome.PASSED, Outcome.NO_SPECS, Outcome.PASSED]);
        assert.deepEqual(threads.map((thread) => thread.attempts), [2, 1, 2]);
        assert.deepEqual(threads.map((thread) => thread.previousAttempts), [[{ outcome: Outcome.FAILED, restarts: 0 }], [], [{ outcome: Outcome.NOT_RUN, restarts: 0 }]]);
        assert.deepEqual(threads[0].attemptHistory, [{ outcome: Outcome.FAILED, restarts: 0 }, { outcome: Outcome.PASSED, restarts: 0 }]);
        assert.deepEqual(threads.map((thread) => thread.retryReasons), [{ failed: 1, stopped: 0 }, { failed: 0, stopped: 0 }, { failed: 0, stopped: 1 }]);
    });

    it('does nothing more when everything passes', async () => {
        const threads = createThreads([1]);
        const { pool, fake } = createPool({ behaviour: () => scripts.pass(), phaseCount: 1 });

        await runWithRetries({ pool, threads, retries: 3, retryDelay: 0, log: () => { } });

        assert.equal(fake.spawnsFor(1), 1);
    });
});
