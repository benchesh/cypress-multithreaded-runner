const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const path = require('path');

const noConsoleColours = String(process.env.NO_COLOR) === '1';

//for console logs
exports.green = (s) => noConsoleColours ? s : `\x1b[32m${s}\x1b[0m`;
exports.orange = (s) => noConsoleColours ? s : `\x1b[33m${s}\x1b[0m`;
exports.red = (s) => noConsoleColours ? s : `\x1b[31m${s}\x1b[0m`;

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
        'overwriteAllureHistory',
        'generateAllure',
        'endProcessIfTestsFail',
        'jUnitReport.enabled',
        'orderThreadsByBenchmark', 'openAllure', 'combineAllure', 'hostAllure',
        'waitForFileExist.deleteAfterCompletion', 'waitForFileExist.stopWaitingWhenFirstThreadCompletes'
    ])
    .alias('open', 'openAllure')
    .alias('combine', 'combineAllure')
    .alias('host', 'hostAllure')
    .alias('generate', 'generateAllure')
    .alias('specs', 'specFiles')
    .alias([
        'runFailedSpecsFromReportURL',
        'runFailedSpecsFromReportUrl',
        'runFailsFromReportURL',
        'runFailsFromReportUrl',
        'runFailedFromReportURL',
        'runFailedFromReportUrl'
    ], 'runFailedSpecFilesFromReportURL');

exports.getFullConfig = (config) => {
    const fullConfig = { ...config, ...argv };

    (fullConfig.ignoreCliOverrides || []).forEach(prop => {
        fullConfig[prop] = config[prop];
    });

    fullConfig.reportDir = fullConfig.reportDir ? path.resolve(fullConfig.reportDir) : null;
    fullConfig.defaultAllureReportDir = path.join(fullConfig.reportDir, 'allure-report');
    fullConfig.allureReportDir = fullConfig.allureReportDir ? path.join(fullConfig.allureReportDir) : fullConfig.defaultAllureReportDir;
    fullConfig.allureReportHeading = `Cypress Multithreaded Runner${fullConfig.allureReportHeading ? `: ${fullConfig.allureReportHeading}` : ''}`;
    fullConfig.generateAllure = fullConfig.generateAllure ?? true;
    fullConfig.openAllure = fullConfig.openAllure ?? false;

    return fullConfig;
}

exports.calcTimeDifference = (end, start) => {
    return parseInt(
        (end - start) / 1000
    );
}

exports.secondsToNaturalString = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds - (minutes * 60);

    return (
        `${minutes ? `${minutes} minute${minutes !== 1 ? 's' : ''}, ` : ''}${remainingSeconds} second${seconds !== 1 ? 's' : ''}`
    ).replace(', 0 seconds', '');
};

exports.generatePercentageBar = (percentageOfTotal, seconds) => {
    const percentageBar = `${Array.from({ length: Math.round(percentageOfTotal / 2) }, () => '█').concat(
        Array.from({ length: 50 - Math.round(percentageOfTotal / 2) }, () => '░'),
    ).join('')}`;

    return `${percentageBar} ${percentageOfTotal.toFixed(2)}% (${exports.secondsToNaturalString(seconds)})`;
}
