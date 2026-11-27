// Runs threads: decides when each one starts, supervises each Cypress instance (restarts, inactivity
// timeouts, time limits) and stops threads when an earlier phase fails or too many threads time out

const fs = require('fs-extra');
const { EventEmitter } = require('events');
const { Outcome } = require('./Thread');
const {
    CrashDetector,
    hasRunStarted,
    hasRunFinished,
    allSpecsPassed,
    noSpecFilesFound,
} = require('../cypress/logAnalysis');
const { orange, secondsToNaturalString, calcTimeDifference, pluralise } = require('../util/format');

class ThreadPool extends EventEmitter {
    /**
     * @param {object} options
     * @param {object} options.settings normalised settings
     * @param {number} options.phaseCount the total number of phases
     * @param {(thread: object) => EventEmitter} options.processFactory starts Cypress for a thread. The returned
     * object emits `output` (string) and `exit`, and has a `kill()` method
     * @param {import('./LogPrinter').LogPrinter} options.printer
     * @param {object} options.resultsStore
     * @param {(thread: object) => string|null} options.resultsStore.findCrashLogs the result file containing crash messages, if any
     * @param {(thread: object) => void} options.resultsStore.clear deletes results from a crashed run
     * @param {(thread: object) => void} [options.onThreadComplete]
     * @param {(msg: string) => void} [options.warn]
     * @param {(...msg: string[]) => void} [options.verboseLog]
     */
    constructor({
        settings,
        phaseCount,
        processFactory,
        printer,
        resultsStore,
        onThreadComplete = () => { },
        warn = (msg) => console.warn(orange(msg)),
        verboseLog = () => { },
    }) {
        super();
        this.setMaxListeners(0);

        this.settings = settings;
        this.phaseCount = phaseCount;
        this.processFactory = processFactory;
        this.printer = printer;
        this.resultsStore = resultsStore;
        this.onThreadComplete = onThreadComplete;
        this.printWarning = warn;
        this.verboseLog = verboseLog;

        this.processes = new Map();
        this.timeLimitTimers = new Map();
        this.resetRunState([]);
    }

    resetRunState(threads) {
        this.threads = threads;
        /** threads in phases after this phase number will be stopped */
        this.phaseLock = null;
        this.timeoutCount = 0;
        this.running = 0;
    }

    warn(thread, msg) {
        this.printWarning(msg);
        thread?.addTimestampedLog(msg);
    }

    /**
     * Run a set of threads to completion
     *
     * @param {import('./Thread').Thread[]} threads in the order they should start
     */
    async run(threads) {
        this.resetRunState(threads);
        this.printer.track(threads);

        const { threadDelay, waitForFileExist } = this.settings;
        const delayMs = threadDelay * 1000;
        const [first, second, ...rest] = threads;
        const inProgress = [];

        if (first) {
            inProgress.push(this.startThread(first));
        }

        if (second) {
            if (waitForFileExist) {
                // waitForFile checks for the file in intervals of .5s
                await this.waitForSlot(delayMs - 500);
                await this.waitForFile(second);
            } else {
                await this.waitForSlot(delayMs);
            }

            inProgress.push(this.startThread(second));

            for (const thread of rest) {
                if (thread.outcome) {
                    continue;
                }

                await this.waitForSlot(delayMs);

                if (this.phaseLock && thread.phaseNo > this.phaseLock) {
                    break;
                }

                inProgress.push(this.startThread(thread));
            }
        }

        await Promise.all(inProgress);

        threads.filter((thread) => !thread.complete).forEach((thread) => {
            thread.outcome = thread.outcome || Outcome.NOT_RUN;
            thread.complete = true;
            this.printer.skip(thread);
        });

        this.printer.flushAll();
    }

    /**
     * Wait for `ms` (cut short when any thread starts running or completes), then for a free slot
     */
    waitForSlot(ms) {
        return new Promise((resolve) => {
            let timer;

            const check = () => {
                if (this.running < this.settings.maxConcurrentThreads) {
                    clearTimeout(timer);
                    this.off('nudge', onNudge);
                    resolve();
                }
            };

            const onNudge = () => {
                clearTimeout(timer);
                check();
            };

            this.on('nudge', onNudge);
            timer = setTimeout(check, Math.max(ms, 0));
        });
    }

    /**
     * Wait for the waitForFileExist file, before the second thread starts
     */
    waitForFile(secondThread) {
        const { filepath, minSize, timeout, stopWaitingWhenFirstThreadCompletes } = this.settings.waitForFileExist;
        let remaining = timeout;

        return new Promise((resolve) => {
            const interval = setInterval(() => {
                const done = (warning) => {
                    if (warning) {
                        this.warn(secondThread, warning);
                    }

                    clearInterval(interval);
                    resolve();
                };

                if (fs.existsSync(filepath) && fs.statSync(filepath).size >= minSize) {
                    done();
                } else if (stopWaitingWhenFirstThreadCompletes && this.threads.some((thread) => thread.complete)) {
                    done(`WARNING: There may be an issue as the first thread has completed but the "${filepath}" file doesn't exist... will continue anyway!`);
                } else {
                    remaining -= 0.5;

                    if (remaining <= 0) {
                        done(`WARNING: There may be an issue as the "${filepath}" file doesn't exist after ${timeout} seconds... will continue anyway!`);
                    }
                }
            }, 500);
        });
    }

    startThread(thread) {
        return this.spawn(thread, { runStarted: false });
    }

    /**
     * Why a thread can't (re)start right now, if it can't
     */
    blockedOutcome(thread) {
        if (this.timeoutCount > this.settings.maxAllowedTimeouts) {
            return Outcome.ABORTED;
        }

        if (this.phaseLock && this.phaseLock < thread.phaseNo) {
            return thread.started ? Outcome.STOPPED : Outcome.NOT_RUN;
        }

        return null;
    }

    async spawn(thread, { runStarted }) {
        if (!thread.outcome) {
            thread.outcome = this.blockedOutcome(thread);
        }

        if (thread.outcome) {
            if (thread.started) {
                this.completeThread(thread, { failed: true });
            } else {
                thread.complete = true;
                this.printer.skip(thread);
            }

            return;
        }

        if (!thread.started) {
            thread.started = true;
            thread.startTime = performance.now();
            this.running++;
            this.startTimeLimit(thread);
        }

        this.printer.announceStart(thread, this.running);

        const proc = this.processFactory(thread);
        this.processes.set(thread.threadNo, proc);

        const spawnState = { logs: '', restartRequested: false, crashDetector: new CrashDetector(), inactivityTimer: null };

        const resetInactivityTimer = () => {
            const { threadInactivityTimeout } = this.settings;

            clearTimeout(spawnState.inactivityTimer);

            if (!threadInactivityTimeout) {
                return;
            }

            spawnState.inactivityTimer = setTimeout(() => {
                this.warn(thread, `The Cypress instance in thread #${thread.threadNo} hasn't responded for ${secondsToNaturalString(threadInactivityTimeout)} and will be considered a crash.`);
                spawnState.restartRequested = true;
                proc.kill();
            }, threadInactivityTimeout * 1000);
        };

        const handleOutput = (chunk) => {
            thread.appendLog(chunk);
            spawnState.logs += chunk;
            this.printer.output(thread, chunk);
            resetInactivityTimer();

            if (spawnState.crashDetector.push(chunk)) {
                this.verboseLog(`Internal Cypress error in thread #${thread.threadNo}`);
                spawnState.restartRequested = true;
                proc.kill();
            } else if (noSpecFilesFound(chunk)) {
                this.verboseLog(`No spec files detected on thread #${thread.threadNo}`);
                thread.outcome = Outcome.NO_SPECS;
                proc.kill();
            } else if (!runStarted && hasRunStarted(chunk)) {
                runStarted = true;
                this.verboseLog(`Detected run start on thread #${thread.threadNo}`);
                this.emit('nudge');
            }
        };

        const exited = new Promise((resolve) => proc.once('exit', resolve));
        proc.on('output', handleOutput);
        handleOutput(`Start of thread #${thread.threadNo}:\n`);

        await exited;

        clearTimeout(spawnState.inactivityTimer);
        this.processes.delete(thread.threadNo);

        // stopped, timed out or no spec files: no point restarting
        if (thread.outcome) {
            this.completeThread(thread, { failed: true });
            return;
        }

        const crashed = spawnState.restartRequested
            || !hasRunFinished(spawnState.logs)
            || this.crashLogsInResults(thread);

        if (crashed) {
            thread.restarts++;

            if (thread.restarts <= this.settings.maxThreadRestarts) {
                this.warn(thread, `WARNING: Internal Cypress error in thread #${thread.threadNo}! Restarting it (restart ${thread.restarts} of a maximum of ${this.settings.maxThreadRestarts}).`);

                // delete any test results as they'll interfere with the next run
                this.resultsStore.clear(thread);

                await this.spawn(thread, { runStarted });
                return;
            }

            thread.outcome = Outcome.CRASHED;
            this.warn(thread, `CRITICAL ERROR: Too many internal Cypress errors in thread #${thread.threadNo}. Giving up after ${pluralise(this.settings.maxThreadRestarts, 'restart')}!`);
            this.completeThread(thread, { failed: true });
            return;
        }

        thread.outcome = allSpecsPassed(spawnState.logs) ? Outcome.PASSED : Outcome.FAILED;
        this.completeThread(thread, { failed: thread.outcome === Outcome.FAILED });
    }

    /**
     * Cypress may record a crash in the Allure results without it showing in the console output
     */
    crashLogsInResults(thread) {
        const file = this.resultsStore.findCrashLogs(thread);

        if (file) {
            this.warn(thread, `Illegal log detected in Allure result file "${file}" for thread #${thread.threadNo}`);
        }

        return Boolean(file);
    }

    startTimeLimit(thread) {
        const { threadTimeLimit, maxAllowedTimeouts } = this.settings;

        if (!threadTimeLimit) {
            return;
        }

        this.timeLimitTimers.set(thread.threadNo, setTimeout(() => {
            if (thread.complete || thread.outcome) {
                return;
            }

            thread.outcome = Outcome.TIMED_OUT;
            this.timeoutCount++;

            const limitStr = secondsToNaturalString(threadTimeLimit);

            if (this.timeoutCount > maxAllowedTimeouts) {
                this.warn(thread, `CRITICAL ERROR: The Cypress instance in thread #${thread.threadNo} has failed to complete within the maximum time limit of ${limitStr}. ${pluralise(this.timeoutCount, 'thread has', 'threads have')} timed out, and the maximum number of threads allowed to time out is ${maxAllowedTimeouts}, so all threads will stop running.`);

                if ((!this.phaseLock || thread.phaseNo < this.phaseLock) && this.settings.stopSubsequentPhasesOnFail) {
                    this.phaseLock = thread.phaseNo;
                }

                this.threads.forEach((other) => this.stopThread(other, Outcome.ABORTED));
            } else {
                const remaining = (maxAllowedTimeouts + 1) - this.timeoutCount;
                this.warn(thread, `CRITICAL ERROR: The Cypress instance in thread #${thread.threadNo} has failed to complete within the maximum time limit of ${limitStr}. It will now stop running immediately. All threads will stop running if ${pluralise(remaining, 'more thread times out', 'more threads time out')}!`);
            }

            this.verboseLog(`Thread #${thread.threadNo} timeout`);
            this.processes.get(thread.threadNo)?.kill();
        }, threadTimeLimit * 1000));
    }

    /**
     * Stop a thread that hasn't finished yet
     */
    stopThread(thread, outcome) {
        if (thread.complete || thread.outcome) {
            return;
        }

        thread.outcome = outcome;
        clearTimeout(this.timeLimitTimers.get(thread.threadNo));

        const proc = this.processes.get(thread.threadNo);

        if (proc) {
            proc.kill(); // the exit handler will complete the thread
        } else if (!thread.started) {
            thread.complete = true;
            this.printer.skip(thread);
        }
    }

    /**
     * When a thread fails, stop every thread in subsequent phases (see stopSubsequentPhasesOnFail)
     */
    lockSubsequentPhases(thread) {
        if (
            !this.settings.stopSubsequentPhasesOnFail
            || (this.phaseLock && thread.phaseNo >= this.phaseLock)
            || thread.phaseNo >= this.phaseCount
        ) {
            return;
        }

        this.phaseLock = thread.phaseNo;

        const subsequentThreads = this.threads.filter((other) => other.phaseNo > this.phaseLock);

        if (!subsequentThreads.length) {
            return;
        }

        this.warn(thread, `Thread #${thread.threadNo} failed, and as it's from phase #${this.phaseLock}, all threads from following phases will be stopped immediately. Any remaining threads from phase ${this.phaseLock} will continue running.`);

        subsequentThreads.forEach((other) => this.stopThread(other, other.started ? Outcome.STOPPED : Outcome.NOT_RUN));
    }

    completeThread(thread, { failed }) {
        clearTimeout(this.timeLimitTimers.get(thread.threadNo));
        this.printer.finished(thread);

        if (failed && this.timeoutCount <= this.settings.maxAllowedTimeouts) {
            this.lockSubsequentPhases(thread);
        }

        thread.complete = true;
        this.running--;

        if (![Outcome.STOPPED, Outcome.ABORTED].includes(thread.outcome)) {
            thread.secs = calcTimeDifference(performance.now(), thread.startTime);
        }

        this.onThreadComplete(thread);
        this.emit('nudge');
    }

    /**
     * Failsafe: kill any Cypress instance that's still running
     */
    killAll() {
        this.processes.forEach((proc) => proc.kill());
        this.timeLimitTimers.forEach((timer) => clearTimeout(timer));
    }
}

module.exports = {
    ThreadPool,
};
