const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { argv } = yargs(hideBin(process.argv))
    .array(['ignoreCliOverrides', 'phases', 'phaseDefaults.onlyRunSpecFilesIncludingAnyText', 'phaseDefaults.onlyRunSpecFilesIncludingAllText', 'specFiles'])
    .choices('logMode', [1, 2, 3, 4])
    .choices('threadMode', [1, 2])
    .number(['maxThreadRestarts', 'threadDelay',
        'threadInactivityTimeout', 'threadTimeLimit',
        'maxConcurrentThreads',
        'waitForFileExist.minSize', 'waitForFileExist.timeout',
        'repeat'
    ])
    .boolean([
        'endProcessIfTestsFail',
        'orderThreadsByBenchmark', 'openAllure', 'combineAllure', 'hostAllure',
        'waitForFileExist.deleteAfterCompletion', 'waitForFileExist.stopWaitingWhenFirstThreadCompletes'
    ])
    .alias('open', 'openAllure')
    .alias('combine', 'combineAllure')
    .alias('host', 'hostAllure')

exports.getFullConfig = (config) => {
    const fullConfig = { ...config, ...argv };

    (fullConfig.ignoreCliOverrides || []).forEach(prop => {
        fullConfig[prop] = config[prop];
    });

    return fullConfig;
}
