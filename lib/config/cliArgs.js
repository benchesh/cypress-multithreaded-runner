// Command line overrides. Every option can be overridden via the CLI (camelCase or kebab-case);
// this file defines the types and aliases yargs needs to parse them correctly

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

const RUN_FAILED_FROM_REPORT_URL_ALIASES = [
    'runFailedTestFilesFromReportURL',
    'runFailedTestFilesFromReportUrl',
    'runFailedTestsFromReportURL',
    'runFailedTestsFromReportUrl',
    'runFailedSpecsFromReportURL',
    'runFailedSpecsFromReportUrl',
    'runFailsFromReportURL',
    'runFailsFromReportUrl',
    'runFailedFromReportURL',
    'runFailedFromReportUrl',
    'runFailedSpecsFromReportPath',
    'runFailedSpecsFromReportFilepath',
    'runFailsFromReportPath',
    'runFailsFromReportFilepath',
    'runFailedFromReportPath',
    'runFailedFromReportFilepath',
    'runFailedSpecsFromURL',
    'runFailedSpecsFromUrl',
    'runFailsFromURL',
    'runFailsFromUrl',
    'runFailedFromURL',
    'runFailedFromUrl',
    'runFailedSpecsFromPath',
    'runFailedSpecsFromFilepath',
    'runFailedFromPath',
    'runFailedFromFilepath',
    'runFailsFromPath',
    'runFailsFromFilepath',
];

const RUN_MOST_RECENTLY_FAILED_ALIASES = [
    'runMostRecentlyFailedTestsFromReportsDir',
    'runRecentlyFailedTestsFromReportsDir',
    'runMostRecentlyFailedSpecsFromReportsDir',
    'runMostRecentlyFailedFromReportsDir',
    'runRecentlyFailedSpecFilesFromReportsDir',
    'runRecentlyFailedSpecsFromReportsDir',
    'runRecentlyFailedFromReportsDir',
];

/**
 * Parse CLI arguments into a config object that can be merged over the user's config
 *
 * @param {string[]} argv the raw process arguments
 * @returns {object}
 */
const parseCliArgs = (argv = process.argv) => {
    const parsed = yargs(hideBin(argv))
        .help(false)
        .version(false)
        .array([
            'ignoreCliOverrides',
            'phases',
            'phaseDefaults.onlyRunSpecFilesIncludingAnyText',
            'phaseDefaults.onlyRunSpecFilesIncludingAllText',
            'phaseDefaults.onlyRunSpecFilesNotIncludingAnyText',
            'phaseDefaults.onlyRunSpecFilesNotIncludingAllText',
            'specFiles',
            'maxConcurrentThreadsExperiment',
            'specFileExts',
        ])
        .choices('logMode', [1, 2, 3, 4])
        .number([
            'maxThreadRestarts',
            'threadDelay',
            'threadInactivityTimeout',
            'threadTimeLimit',
            'maxConcurrentThreads',
            'maxAllowedTimeouts',
            'waitForFileExist.minSize',
            'waitForFileExist.timeout',
            'repeat',
            'retryAllFailedSpecs',
            'retryAllFailedSpecsDelay',
            'onlyPhaseNo',
            'startingPhaseNo',
            'endingPhaseNo',
        ])
        .boolean([
            'verbose',
            'clean',
            'notify',
            'overwriteAllureHistory',
            'generateAllure',
            'endProcessIfTestsFail',
            'jUnitReport.enabled',
            'orderThreadsByBenchmark',
            'saveThreadBenchmark',
            'openAllure',
            'combineAllure',
            'hostAllure',
            'waitForFileExist.deleteAfterCompletion',
            'waitForFileExist.stopWaitingWhenFirstThreadCompletes',
            'stopSubsequentPhasesOnFail',
        ])
        .alias('stopSubsequentPhasesOnFail', 'stopFuturePhasesOnFail')
        .alias('open', 'openAllure')
        .alias('combine', 'combineAllure')
        .alias('host', 'hostAllure')
        .alias('generate', 'generateAllure')
        .alias('specs', 'specFiles')
        .alias(RUN_MOST_RECENTLY_FAILED_ALIASES, 'runMostRecentlyFailedSpecFilesFromReportsDir')
        .alias(RUN_FAILED_FROM_REPORT_URL_ALIASES, 'runFailedSpecFilesFromReportURL')
        .parserConfiguration({ 'strip-dashed': true })
        .parse();

    // yargs sets boolean flags to `undefined` when they aren't passed; drop those (and yargs internals)
    // so they don't override the user's config
    return Object.fromEntries(
        Object.entries(parsed).filter(([key, value]) => value !== undefined && key !== '_' && key !== '$0'),
    );
};

module.exports = {
    parseCliArgs,
    RUN_FAILED_FROM_REPORT_URL_ALIASES,
    RUN_MOST_RECENTLY_FAILED_ALIASES,
};
