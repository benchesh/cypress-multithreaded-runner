// Turns the user's config (plus CLI overrides) into a single, fully-defaulted settings object.
// Every other module reads from this object rather than from the raw config

const os = require('os');
const path = require('path');
const { parseCliArgs } = require('./cliArgs');
const { DEFAULT_CRASH_PATTERNS } = require('../cypress/crashPatterns');

const DEFAULT_SPEC_FILE_EXTS = ['js', 'jsx', 'ts', 'tsx', 'coffee'];

// Phase options may be given at the top level of the config when `phases` isn't used
const PHASE_KEYS = [
    'cypressConfig',
    'title',
    'specsDir',
    'specFileExts',
    'browser',
    'grep',
    'grepTags',
    'grepUntagged',
    'onlyRunSpecFilesIncludingAnyText',
    'onlyRunSpecFilesIncludingAllText',
    'onlyRunSpecFilesNotIncludingAnyText',
    'onlyRunSpecFilesNotIncludingAllText',
    'passthroughEnvArgs',
];

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const deepMerge = (base, override) => {
    const result = { ...base };

    Object.entries(override).forEach(([key, value]) => {
        result[key] = isPlainObject(value) && isPlainObject(base[key])
            ? deepMerge(base[key], value)
            : value;
    });

    return result;
};

/**
 * Merge CLI overrides over the user's config, honouring `ignoreCliOverrides`
 *
 * @param {object} config the config passed to the runner
 * @param {object} cliArgs parsed CLI arguments
 * @returns {object} the merged (but not yet normalised) config
 */
const mergeCliOverrides = (config = {}, cliArgs = parseCliArgs()) => {
    const merged = deepMerge(config, cliArgs);

    (merged.ignoreCliOverrides || []).forEach((key) => {
        merged[key] = config[key];
    });

    return merged;
};

/**
 * includeRepoPath: true (link spec files to their git repo, if one can be found), a URL to link them to instead,
 * or false. Anything falsy means no links, and only leaving the option out gives the default (true). Strings
 * such as "false" (e.g. from the CLI) are understood too
 */
const normaliseIncludeRepoPath = (value) => {
    if (value === undefined) {
        return true;
    }

    if (typeof value !== 'string') {
        return Boolean(value);
    }

    const trimmed = value.trim();
    const lowercase = trimmed.toLowerCase();

    if (['', 'false', '0', 'no'].includes(lowercase)) {
        return false;
    }

    return ['true', '1', 'yes'].includes(lowercase) ? true : trimmed;
};

/**
 * The text that marks a Cypress crash. Whatever the user gives replaces the defaults (it isn't added to them),
 * and an empty list means nothing is ever detected as a crash. Blank patterns are dropped, as they'd match everything.
 * Anything that isn't a string or a list of strings is ignored in favour of the defaults
 */
const normaliseCrashPatterns = (value) => {
    if (typeof value !== 'string' && !Array.isArray(value)) {
        return [...DEFAULT_CRASH_PATTERNS];
    }

    return [value].flat()
        .filter((pattern) => ['string', 'number'].includes(typeof pattern))
        .map((pattern) => String(pattern).toLowerCase())
        .filter((pattern) => pattern.trim());
};

/**
 * Normalise a "string or array of strings" option into a lowercase array, or null if empty
 */
const toLowercaseArray = (value) => {
    if (!value) {
        return null;
    }

    const arr = (Array.isArray(value) ? value : [value]).filter((str) => str).map((str) => String(str).toLowerCase());

    return arr.length ? arr : null;
};

const nonNegativeNumber = (value, fallback) => {
    const num = Number(value);

    return Number.isFinite(num) && num >= 0 ? num : fallback;
};

const normalisePhase = (phase, index) => {
    const phaseNo = index + 1;

    return {
        phaseNo,
        title: `[PHASE #${phaseNo}${phase.title ? `: ${phase.title}` : ''}]`,
        specsDir: phase.specsDir ? path.join(phase.specsDir) : null,
        specFileExts: phase.specFileExts?.length ? phase.specFileExts : DEFAULT_SPEC_FILE_EXTS,
        browser: phase.browser || null,
        cypressConfigFilepath: phase.cypressConfig?.filepath ? path.join(phase.cypressConfig.filepath) : null,
        cypressConfigObject: phase.cypressConfig?.object || {},
        grep: phase.grep || null,
        grepTags: phase.grepTags || null,
        grepUntagged: phase.grepUntagged || null,
        passthroughEnvArgs: phase.passthroughEnvArgs || null,
        textFilters: {
            includingAny: toLowercaseArray(phase.onlyRunSpecFilesIncludingAnyText),
            includingAll: toLowercaseArray(phase.onlyRunSpecFilesIncludingAllText),
            notIncludingAny: toLowercaseArray(phase.onlyRunSpecFilesNotIncludingAnyText),
            notIncludingAll: toLowercaseArray(phase.onlyRunSpecFilesNotIncludingAllText),
        },
    };
};

const resolvePhases = (config) => {
    const phaseDefaults = config.phaseDefaults || {};

    const phases = Array.isArray(config.phases) && config.phases.length
        ? config.phases
        // no phases given: the top-level config describes a single phase
        : [Object.fromEntries(PHASE_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]))];

    return phases.map((phase, index) => normalisePhase({ ...phaseDefaults, ...phase }, index));
};

/**
 * Build the settings object from an already merged config (see `mergeCliOverrides`)
 *
 * @param {object} config
 * @returns {object}
 */
const normaliseSettings = (config = {}) => {
    const reportDir = config.reportDir ? path.resolve(config.reportDir) : path.resolve('');
    const defaultAllureReportDir = path.join(reportDir, 'allure-report');
    const defaultAllureHistoryDir = path.resolve(reportDir, 'allure-results', 'history');
    const heading = `Cypress Multithreaded Runner${config.allureReportHeading ? `: ${config.allureReportHeading}` : ''}`;

    const waitForFileExist = config.waitForFileExist?.filepath
        ? {
            filepath: config.waitForFileExist.filepath,
            minSize: nonNegativeNumber(config.waitForFileExist.minSize, 2),
            timeout: nonNegativeNumber(config.waitForFileExist.timeout, 60),
            deleteAfterCompletion: Boolean(config.waitForFileExist.deleteAfterCompletion),
            stopWaitingWhenFirstThreadCompletes: config.waitForFileExist.stopWaitingWhenFirstThreadCompletes ?? true,
        }
        : null;

    return {
        heading,
        reportDir,
        clean: Boolean(config.clean),
        verbose: Boolean(config.verbose),
        notify: config.notify ?? true,

        // Allure
        generateAllure: config.generateAllure ?? true,
        openAllure: config.openAllure ?? false,
        combineAllure: config.combineAllure ?? true,
        hostAllure: config.hostAllure ?? false,
        includeRepoPath: normaliseIncludeRepoPath(config.includeRepoPath),
        allureResultsDir: path.resolve(reportDir, 'allure-results'),
        defaultAllureReportDir,
        allureReportDir: config.allureReportDir ? path.join(config.allureReportDir) : defaultAllureReportDir,
        defaultAllureHistoryDir,
        allureHistoryDir: config.allureHistoryDir ?? defaultAllureHistoryDir,
        overwriteAllureHistory: config.overwriteAllureHistory ?? true,

        // which spec files to run
        phases: resolvePhases(config),
        specFiles: config.specFiles?.length ? config.specFiles : null,
        runFailedSpecFilesFromReportURL: config.runFailedSpecFilesFromReportURL || null,
        runFailedSpecFilesFromObject: config.runFailedSpecFilesFromObject || null,
        runMostRecentlyFailedSpecFilesFromReportsDir: config.runMostRecentlyFailedSpecFilesFromReportsDir || null,
        onlyPhaseNo: config.onlyPhaseNo || null,
        startingPhaseNo: config.startingPhaseNo || null,
        endingPhaseNo: config.endingPhaseNo || null,
        repeat: Math.max(1, Math.floor(Number(config.repeat) || 1)),

        // threads
        logMode: [1, 2, 3, 4].includes(Number(config.logMode)) ? Number(config.logMode) : 1,
        maxConcurrentThreads: Number(config.maxConcurrentThreads) || Math.ceil(os.cpus().length / 2),
        threadDelay: nonNegativeNumber(config.threadDelay, 30),
        maxThreadRestarts: nonNegativeNumber(config.maxThreadRestarts, 5),
        crashPatterns: normaliseCrashPatterns(config.crashPatterns),
        threadInactivityTimeout: nonNegativeNumber(config.threadInactivityTimeout, 60 * 10),
        threadTimeLimit: nonNegativeNumber(config.threadTimeLimit, 60 * 30),
        maxAllowedTimeouts: nonNegativeNumber(config.maxAllowedTimeouts, 4),
        stopSubsequentPhasesOnFail: config.stopSubsequentPhasesOnFail ?? true,
        waitForFileExist,
        retryAllFailedSpecs: Math.max(0, Math.floor(Number(config.retryAllFailedSpecs) || 0)),
        retryAllFailedSpecsDelay: Math.max(0, Number(config.retryAllFailedSpecsDelay) || 0),

        // benchmark
        orderThreadsByBenchmark: config.orderThreadsByBenchmark ?? true,
        saveThreadBenchmark: config.saveThreadBenchmark ?? true,
        threadBenchmarkFilepath: config.threadBenchmarkFilepath || 'cmr-benchmarks.json',
        benchmarkDescription: config.benchmarkDescription ?? null,
        benchmarkCustomMetadata: config.benchmarkCustomMetadata,

        // other outputs
        jUnitReport: config.jUnitReport?.enabled ? config.jUnitReport : null,
        customLogs: Array.isArray(config.customLogs) ? config.customLogs : [],
        endProcessIfTestsFail: config.endProcessIfTestsFail ?? true,

        maxConcurrentThreadsExperiment: config.maxConcurrentThreadsExperiment || null,
        maxConcurrentThreadsExperimentInProg: Boolean(config.maxConcurrentThreadsExperimentInProg),
    };
};

module.exports = {
    mergeCliOverrides,
    normaliseSettings,
    toLowercaseArray,
    DEFAULT_SPEC_FILE_EXTS,
};
