const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const { argv } = yargs(hideBin(process.argv))
    .array([
        'ignoreCliOverrides',
        'phases',
        'phaseDefaults.onlyRunSpecFilesIncludingAnyText',
        'phaseDefaults.onlyRunSpecFilesIncludingAllText',
        'specFiles',
        'maxConcurrentThreadsExperiment'
    ])
    .choices('logMode', [1, 2, 3, 4])
    .choices('threadMode', [1, 2])
    .number(['maxThreadRestarts', 'threadDelay',
        'threadInactivityTimeout', 'threadTimeLimit',
        'maxConcurrentThreads',
        'waitForFileExist.minSize', 'waitForFileExist.timeout',
        'repeat'
    ])
    .boolean([
        'generateAllure',
        'endProcessIfTestsFail',
        'orderThreadsByBenchmark', 'openAllure', 'combineAllure', 'hostAllure',
        'waitForFileExist.deleteAfterCompletion', 'waitForFileExist.stopWaitingWhenFirstThreadCompletes'
    ])
    .alias('open', 'openAllure')
    .alias('combine', 'combineAllure')
    .alias('host', 'hostAllure')
    .alias('generate', 'generateAllure')

exports.getFullConfig = (config) => {
    const fullConfig = { ...config, ...argv };

    (fullConfig.ignoreCliOverrides || []).forEach(prop => {
        fullConfig[prop] = config[prop];
    });

    return fullConfig;
}

exports.timeDifference = (end, start) => {
    return parseInt(
        (end - start) / 1000
    );
}

exports.secondsToNaturalString = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - (minutes * 60);

    return `${minutes ? `${minutes} minute${minutes !== 1 ? 's' : ''}, ` : ''}${remainingSeconds} second${seconds !== 1 ? 's' : ''}`;
};

exports.generatePercentageBar = (percentageOfTotal, seconds) => {
    const percentageBar = `${Array.from({ length: Math.round(percentageOfTotal / 2) }, () => '█').concat(
        Array.from({ length: 50 - Math.round(percentageOfTotal / 2) }, () => '░'),
    ).join('')}`;

    return `${percentageBar} ${percentageOfTotal.toFixed(2)}% (${exports.secondsToNaturalString(seconds)})`;
}
