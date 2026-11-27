// The benchmark file records how long each spec file took, so threads can be started slowest-first in
// future runs. It also records which spec files failed and the success percentage of each run

const { phaseEnvString } = require('../cypress/cypressArgs');
const { readJsonSafe, writeJsonSyncRecursive } = require('../util/fs');
const { Outcome } = require('../threads/Thread');

// Remove falsy values from an object
const filterObj = (obj) => Object.fromEntries(Object.entries(obj).filter(([, value]) => value));

/**
 * The properties of a run that identify which benchmark it belongs to
 */
const benchmarkIdentity = (settings, specFiles) => filterObj({
    specFiles,
    onlyPhaseNo: settings.onlyPhaseNo,
    startingPhaseNo: settings.startingPhaseNo,
    endingPhaseNo: settings.endingPhaseNo,
    phases: settings.phases.map((phase) => {
        // the timestamp env arg is deliberately left out, as it would make the id unique to every run
        const envArgs = phaseEnvString(phase);

        return filterObj({
            cypressConfigFilepath: phase.cypressConfigFilepath,
            specsDir: phase.specsDir,
            onlyRunSpecFilesIncludingAnyText: phase.textFilters.includingAny,
            onlyRunSpecFilesIncludingAllText: phase.textFilters.includingAll,
            onlyRunSpecFilesNotIncludingAnyText: phase.textFilters.notIncludingAny,
            onlyRunSpecFilesNotIncludingAllText: phase.textFilters.notIncludingAll,
            additionalCypressEnvArgs: envArgs ? `,${envArgs}` : '',
        });
    }),
});

const encodeId = (str) => {
    try {
        return btoa(str);
    } catch (err) {
        // btoa only supports Latin-1
        return Buffer.from(str, 'utf8').toString('base64');
    }
};

const benchmarkId = (settings, identity) => settings.benchmarkDescription || encodeId(JSON.stringify(identity));

const loadBenchmarks = (filepath) => readJsonSafe(filepath, {}) || {};

/**
 * Order spec files according to a saved benchmark. Spec files not in the benchmark go first
 *
 * @param {string[]} specs
 * @param {string[]|undefined} order the saved order (slowest first)
 */
const orderSpecsByBenchmark = (specs, order) => {
    if (!order) {
        return specs;
    }

    const benchmarkOrder = [...new Set(order)];
    const notInBenchmark = specs.filter((spec) => !benchmarkOrder.includes(spec));
    const inBenchmark = benchmarkOrder.filter((spec) => specs.includes(spec));

    return [...notInBenchmark, ...inBenchmark];
};

/**
 * @param {object} options
 * @param {object} options.identity see benchmarkIdentity
 * @param {object|undefined} options.previous the previously saved record with the same id
 * @param {import('../threads/Thread').Thread[]} options.threads
 * @param {string[]} options.failedSpecs
 * @param {object} options.testStats
 * @param {number} options.timestamp
 * @param {any} options.customMetadata
 * @returns {{record: object, orderChanged: boolean, orderReason: string|null}}
 */
const buildBenchmarkRecord = ({ identity, previous, threads, failedSpecs, testStats, timestamp, customMetadata }) => {
    let order = [...new Set(
        threads.filter((thread) => thread.secs).sort((a, b) => b.secs - a.secs).map((thread) => thread.spec),
    )];

    let orderReason = null;
    const phasesIncomplete = threads.some((thread) => [Outcome.STOPPED, Outcome.NOT_RUN].includes(thread.outcome));

    if (order.length < 2) {
        orderReason = 'two or more threads with different files are required to determine the optimal order';
    } else if (phasesIncomplete) {
        orderReason = 'one or more phases did not complete';
    }

    if (orderReason && previous?.order) {
        order = previous.order;
    }

    const record = {
        ...identity,
        customMetadata,
        order,
        fails: [...new Set(failedSpecs)],
        timestamp,
        successPercentage: testStats.successPercentage,
        tests: {
            total: testStats.total,
            passed: testStats.passed,
            failed: testStats.failed,
            broken: testStats.broken,
            skipped: testStats.skipped,
            unknown: testStats.unknown,
            notRun: testStats.notRun,
            filledIn: testStats.filledIn,
            assumedPassed: testStats.assumedPassed,
        },
    };

    return {
        record,
        orderReason,
        orderChanged: !orderReason && JSON.stringify(previous?.order) !== JSON.stringify(order),
    };
};

const saveBenchmark = (filepath, benchmarks, id, record) => {
    writeJsonSyncRecursive(filepath, { ...benchmarks, [id]: record });
};

module.exports = {
    benchmarkIdentity,
    benchmarkId,
    loadBenchmarks,
    orderSpecsByBenchmark,
    buildBenchmarkRecord,
    saveBenchmark,
};
