const { EventEmitter } = require('events');

const OUTPUT = {
    start: '  (Run Starting)\n',
    pass: '  (Run Finished)\n    ✔  All specs passed!\n',
    fail: '  (Run Finished)\n    ✖  1 of 1 failed (100%)\n',
    crash: 'Because this error occurred during a `before all` hook we are skipping the remaining tests\n',
    noSpecs: 'Can\'t run because no spec files were found.\n',
};

/**
 * A stand-in for a Cypress process. `steps` are run in order: {wait: ms}, {output: string}, {exit: code} or
 * {hang: true} (never exits unless killed)
 */
class FakeCypressProcess extends EventEmitter {
    constructor(steps) {
        super();
        this.pid = Math.floor(Math.random() * 100000);
        this.killed = false;
        this.exited = false;
        this.timers = [];
        setImmediate(() => this.runSteps(steps));
    }

    async runSteps(steps) {
        for (const step of steps) {
            if (this.killed) {
                return;
            }

            if (step.wait) {
                await new Promise((resolve) => this.timers.push(setTimeout(resolve, step.wait)));
            } else if (step.output !== undefined) {
                this.emit('output', step.output);
            } else if (step.hang) {
                return;
            }
        }

        this.exit(0);
    }

    exit(code) {
        if (this.exited) {
            return;
        }

        this.exited = true;
        this.timers.forEach(clearTimeout);
        this.emit('exit', code);
    }

    kill() {
        this.killed = true;
        setImmediate(() => this.exit(null));
    }
}

/**
 * Common scripts
 */
const scripts = {
    pass: (duration = 5) => [{ output: OUTPUT.start }, { wait: duration }, { output: OUTPUT.pass }],
    fail: (duration = 5) => [{ output: OUTPUT.start }, { wait: duration }, { output: OUTPUT.fail }],
    crash: () => [{ output: OUTPUT.start }, { output: OUTPUT.crash }, { hang: true }],
    exitWithoutFinishing: () => [{ output: OUTPUT.start }],
    hang: () => [{ output: OUTPUT.start }, { hang: true }],
    silentHang: () => [{ hang: true }],
    noSpecs: () => [{ output: OUTPUT.noSpecs }, { hang: true }],
};

/**
 * A process factory that runs `behaviour(thread, spawnCount)` to decide each spawn's script,
 * and records what happened
 */
const createFakeFactory = (behaviour) => {
    const spawns = [];
    let running = 0;
    let maxRunning = 0;

    const factory = (thread) => {
        const spawnCount = spawns.filter((s) => s.threadNo === thread.threadNo).length;
        spawns.push({ threadNo: thread.threadNo, attempt: thread.attempts, at: Date.now() });

        const proc = new FakeCypressProcess(behaviour(thread, spawnCount));

        running++;
        maxRunning = Math.max(maxRunning, running);
        proc.once('exit', () => { running--; });

        return proc;
    };

    return {
        factory,
        spawns,
        spawnsFor: (threadNo) => spawns.filter((s) => s.threadNo === threadNo).length,
        get maxRunning() { return maxRunning; },
    };
};

module.exports = {
    FakeCypressProcess,
    createFakeFactory,
    scripts,
    OUTPUT,
};
