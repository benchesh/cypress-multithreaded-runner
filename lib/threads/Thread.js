// The state of a single thread: one Cypress instance running one spec file

const { getTimeStr } = require('../util/format');

/**
 * Why a thread ended
 */
const Outcome = Object.freeze({
    /** Cypress finished and every spec passed */
    PASSED: 'passed',
    /** Cypress finished but one or more tests failed */
    FAILED: 'failed',
    /** Cypress kept crashing and the thread ran out of restarts */
    CRASHED: 'crashed',
    /** the thread went over threadTimeLimit */
    TIMED_OUT: 'timedOut',
    /** stopped because too many other threads timed out (maxAllowedTimeouts) */
    ABORTED: 'aborted',
    /** stopped while running because a thread in an earlier phase failed */
    STOPPED: 'stopped',
    /** never started because a thread in an earlier phase failed */
    NOT_RUN: 'notRun',
    /** Cypress couldn't find the spec file */
    NO_SPECS: 'noSpecs',
});

/**
 * Outcomes where the thread didn't get the chance to run all of its tests, and why
 */
const INCOMPLETE_OUTCOMES = Object.freeze({
    [Outcome.CRASHED]: 'broken',
    [Outcome.TIMED_OUT]: 'broken',
    [Outcome.ABORTED]: 'broken',
    // tests that were meant to run but were stopped are failures, not skips
    [Outcome.STOPPED]: 'failed',
    [Outcome.NOT_RUN]: 'failed',
});

/**
 * Outcomes where the thread didn't get to run (or finish) because a thread in an earlier phase failed, rather than
 * because of a problem of its own
 */
const STOPPED_BY_EARLIER_PHASE = Object.freeze([Outcome.STOPPED, Outcome.NOT_RUN]);

class Thread {
    /**
     * @param {object} options
     * @param {number} options.threadNo
     * @param {object} options.phase normalised phase settings
     * @param {string} options.spec the spec file this thread runs
     */
    constructor({ threadNo, phase, spec }) {
        this.threadNo = threadNo;
        this.phase = phase;
        this.phaseNo = phase.phaseNo;
        this.spec = spec;

        /** @type {string|null} see Outcome */
        this.outcome = null;
        this.started = false;
        this.complete = false;

        /** the number of times Cypress crashed and was restarted, in the current attempt */
        this.restarts = 0;
        /** 1 + the number of times the thread was re-run by retryAllFailedSpecs */
        this.attempts = 1;
        /** how each previous attempt ended (see retryAllFailedSpecs) */
        this.previousAttempts = [];

        /** output from the current attempt */
        this.logs = '';
        /** output from previous attempts (see retryAllFailedSpecs) */
        this.previousLogs = '';
        /** every log and warning, with the time it occurred */
        this.logsTimestamped = [];

        this.startTime = null;
        /** how long the thread took, in seconds */
        this.secs = undefined;

        /** Allure results collected from every attempt (see allure/results.js) */
        this.results = [];
        /** whether any Allure result files were produced at all */
        this.hasResults = false;
    }

    get fullLogs() {
        return `${this.previousLogs}${this.logs}`;
    }

    get finished() {
        return this.complete || Boolean(this.outcome);
    }

    /**
     * How every attempt ended, including the current one
     *
     * @returns {Array<{outcome: string|null, restarts: number}>}
     */
    get attemptHistory() {
        return [...this.previousAttempts, { outcome: this.outcome, restarts: this.restarts }];
    }

    /**
     * Why the thread was retried: how many of its previous attempts failed, and how many were stopped because a
     * thread in an earlier phase failed
     */
    get retryReasons() {
        const stopped = this.previousAttempts.filter(({ outcome }) => STOPPED_BY_EARLIER_PHASE.includes(outcome)).length;

        return { failed: this.previousAttempts.length - stopped, stopped };
    }

    appendLog(log) {
        this.logs += log;
        this.addTimestampedLog(log);
    }

    addTimestampedLog(log) {
        // keeps the extra line if the log starts with one
        this.logsTimestamped.push([getTimeStr(), log.startsWith('\n') && log.trim() ? `\n${log}` : log]);
    }

    /**
     * Reset the thread so it can run again (see retryAllFailedSpecs), keeping the logs of previous attempts
     */
    prepareRetry(retryLog) {
        this.previousLogs = `${this.fullLogs}${retryLog}`;
        this.logs = '';
        this.addTimestampedLog(retryLog);
        this.previousAttempts.push({ outcome: this.outcome, restarts: this.restarts });
        this.attempts++;
        this.outcome = null;
        this.started = false;
        this.complete = false;
        this.restarts = 0;
        this.startTime = null;
        this.secs = undefined;
    }
}

module.exports = {
    Thread,
    Outcome,
    INCOMPLETE_OUTCOMES,
    STOPPED_BY_EARLIER_PHASE,
};
