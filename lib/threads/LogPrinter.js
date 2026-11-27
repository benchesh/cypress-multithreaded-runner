// Prints thread output to the console according to the logMode setting:
// 1: one thread at a time, in the order the threads started
// 2: one thread at a time, but threads that finish early are printed as soon as the current thread completes
// 3: everything as soon as it arrives
// 4: as 3, then everything again, separated by thread, once all threads complete

const PrintState = Object.freeze({
    /** nothing printed yet */
    NONE: 'none',
    /** currently streaming to the console */
    STREAMING: 'streaming',
    /** finished, waiting for its turn to be printed */
    QUEUED: 'queued',
    /** everything printed */
    DONE: 'done',
});

class LogPrinter {
    /**
     * @param {object} options
     * @param {number} options.logMode
     * @param {(str: string) => void} [options.write]
     * @param {(str: string) => void} [options.log]
     */
    constructor({ logMode, write = (str) => process.stdout.write(str), log = console.log }) {
        this.logMode = logMode;
        this.write = write;
        this.log = log;
        /** @type {Map<number, {thread: object, state: string}>} */
        this.entries = new Map();
    }

    get immediate() {
        return this.logMode >= 3;
    }

    /**
     * Start tracking a set of threads (the order given is the order logs are printed in, in logMode 1)
     */
    track(threads) {
        threads.forEach((thread) => this.entries.set(thread.threadNo, { thread, state: PrintState.NONE }));
    }

    /**
     * Stop tracking every thread, printing anything still queued (used before retrying threads)
     */
    flushAll() {
        this.entries.forEach((entry) => {
            if (!this.immediate && entry.state === PrintState.QUEUED) {
                this.write(entry.thread.logs);
            }
        });

        this.entries.clear();
    }

    isAnyThreadActive() {
        return [...this.entries.values()].some((e) => e.state === PrintState.STREAMING || e.state === PrintState.QUEUED);
    }

    announceStart(thread, runningThreads) {
        const entry = this.entries.get(thread.threadNo);

        if (runningThreads > 1 && !this.immediate && entry?.state === PrintState.NONE) {
            if (this.logMode === 1) {
                this.log(`Thread #${thread.threadNo} is now starting, and its logs will be printed when all preceding threads have completed.`);
            } else {
                const ahead = [...this.entries.values()]
                    .filter((e) => e.state === PrintState.STREAMING || e.state === PrintState.QUEUED)
                    .map((e) => `#${e.thread.threadNo}`);

                this.log(`Thread #${thread.threadNo} is now starting, and its logs will be printed once thread${ahead.length === 1 ? '' : 's'} ${ahead.join(', ')} ${ahead.length === 1 ? 'has' : 'have'} printed their logs.`);
            }

            return;
        }

        this.log(`Thread #${thread.threadNo} is now starting...`);
    }

    /**
     * A thread produced output (which has already been appended to thread.logs)
     */
    output(thread, chunk) {
        if (this.immediate) {
            this.write(chunk);
            return;
        }

        const entry = this.entries.get(thread.threadNo);

        if (!entry) {
            return;
        }

        if (entry.state === PrintState.STREAMING || entry.state === PrintState.DONE) {
            this.write(chunk);
        } else if (entry.state === PrintState.NONE && !this.isAnyThreadActive()) {
            entry.state = PrintState.STREAMING;
            this.write(thread.logs);
        }
    }

    /**
     * A thread completed: print the queue and hand over to the next thread
     */
    finished(thread) {
        if (this.immediate) {
            return;
        }

        const entry = this.entries.get(thread.threadNo);

        if (!entry) {
            return;
        }

        if (entry.state === PrintState.NONE) {
            entry.state = PrintState.QUEUED;
            return;
        }

        entry.state = PrintState.DONE;

        const entries = [...this.entries.values()];
        const next = entries.find((e) => e.state === PrintState.NONE);

        for (const queued of entries.filter((e) => e.state === PrintState.QUEUED)) {
            // in logMode 1, leave later threads queued to maintain chronology
            if (this.logMode === 1 && next && queued.thread.threadNo > next.thread.threadNo) {
                break;
            }

            queued.state = PrintState.DONE;
            this.write(queued.thread.logs);
        }

        if (next) {
            next.state = PrintState.STREAMING;
            this.write(next.thread.logs);
        }
    }

    /**
     * A thread will never run (e.g. its phase was stopped), so don't wait for it
     */
    skip(thread) {
        const entry = this.entries.get(thread.threadNo);

        if (!entry) {
            return;
        }

        if (entry.state === PrintState.STREAMING) {
            this.finished(thread);
        }

        this.entries.delete(thread.threadNo);
    }

    /**
     * logMode 4: print every thread's logs again, one after the other
     */
    printAllSeparately(threads) {
        if (this.logMode !== 4) {
            return;
        }

        threads.forEach((thread) => this.write(thread.fullLogs));
    }
}

module.exports = {
    LogPrinter,
    PrintState,
};
