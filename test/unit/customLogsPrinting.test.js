const { describe, it, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Run } = require('../../lib/run');

const customLogs = [
    { heading: 'Versions', content: 'app 1.2.3' },
    { content: 'no heading' },
];

const printCustomLogs = (config) => {
    const run = new Run({ phases: [{ specsDir: 'one' }], customLogs, ...config });
    const consoleLog = mock.method(console, 'log', () => { });

    try {
        run.printCustomLogs();

        return { run, printed: consoleLog.mock.calls.map((call) => call.arguments.join(' ')) };
    } finally {
        consoleLog.mock.restore();
    }
};

describe('Run.printCustomLogs', () => {
    it('does not print customLogs to the console unless verbose logs are enabled, but still keeps them for the Allure report', () => {
        const { run, printed } = printCustomLogs();

        assert.deepEqual(printed, []);
        assert.deepEqual(run.customLogs, [
            { heading: 'Versions', content: 'app 1.2.3' },
            { heading: 'Custom Logs 2', content: 'no heading' },
        ]);
    });

    it('prints customLogs to the console when verbose logs are enabled', () => {
        const { run, printed } = printCustomLogs({ verbose: true });

        assert.equal(printed.length, 2);
        assert.match(printed[0], /Versions\n\napp 1\.2\.3/);
        assert.match(printed[1], /Custom Logs 2\n\nno heading/);
        assert.equal(run.customLogs.length, 2);
    });
});
