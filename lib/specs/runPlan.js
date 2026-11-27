// Turns the settings into a plan: which spec files run in each phase, in which order, and as which threads

const path = require('path');
const { findPhaseSpecFiles, specMatchesFilter } = require('./specFiles');
const { orderSpecsByBenchmark } = require('../report/benchmark');
const { Thread } = require('../threads/Thread');
const { getFilesRecursive } = require('../util/fs');

/**
 * Whether the user has chosen not to run a phase (onlyPhaseNo, startingPhaseNo, endingPhaseNo)
 */
const isPhaseSkippedByUser = (settings, phaseNo) => Boolean(
    (settings.onlyPhaseNo && settings.onlyPhaseNo !== phaseNo)
    || (settings.startingPhaseNo && settings.startingPhaseNo > phaseNo)
    || (settings.endingPhaseNo && settings.endingPhaseNo < phaseNo),
);

/**
 * @typedef {object} PhasePlan
 * @property {object} phase normalised phase settings
 * @property {string[]} specs the spec files to run, in order
 * @property {boolean} skipped the user chose not to run this phase
 * @property {string[]} assumedPassedSpecs spec files that won't run because they passed previously
 */

/**
 * @param {object} options
 * @param {object} options.settings
 * @param {import('./specSelection').SpecSelection} options.selection
 * @param {string[]|undefined} options.benchmarkOrder the saved benchmark order, if any
 * @returns {{phases: PhasePlan[], threads: Thread[], missingSpecFiles: string[]}}
 */
const buildRunPlan = ({ settings, selection, benchmarkOrder }) => {
    const { specFiles, assumeOthersPassed } = selection;

    const phases = settings.phases.map((phase) => {
        const allSpecs = findPhaseSpecFiles(phase);
        const skipped = isPhaseSkippedByUser(settings, phase.phaseNo);

        const selected = specFiles
            ? allSpecs.filter((spec) => specFiles.some((specFile) => specMatchesFilter(spec, specFile)))
            : allSpecs;

        return {
            phase,
            specs: settings.orderThreadsByBenchmark ? orderSpecsByBenchmark(selected, benchmarkOrder) : selected,
            skipped,
            assumedPassedSpecs: assumeOthersPassed && !skipped
                ? allSpecs.filter((spec) => !selected.includes(spec))
                : [],
        };
    });

    const threads = [];

    phases.filter((plan) => !plan.skipped).forEach((plan) => {
        for (let i = 0; i < settings.repeat; i++) {
            plan.specs.forEach((spec) => {
                threads.push(new Thread({ threadNo: threads.length + 1, phase: plan.phase, spec }));
            });
        }
    });

    const everySpecFile = settings.phases.flatMap((phase) => getFilesRecursive(phase.specsDir));

    const missingSpecFiles = (specFiles || []).filter(
        (specFile) => !everySpecFile.some((spec) => specMatchesFilter(spec, specFile)),
    );

    return { phases, threads, missingSpecFiles };
};

/**
 * Messages describing the plan, printed before any thread starts
 */
const describeRunPlan = ({ settings, plan, benchmarkOrder, cpuCount }) => {
    const logs = [];
    const notes = [];
    const threadCount = plan.threads.length;

    plan.phases.forEach(({ phase, specs, skipped }) => {
        let log = phase.title;

        if (!specs.length) {
            log += ' (No spec files found, skipping)';
        } else if (skipped) {
            log += ' (Skipping phase)';
        }

        plan.threads.filter((thread) => thread.phase === phase).forEach((thread) => {
            const notInBenchmark = !benchmarkOrder?.includes(thread.spec) ? ' (not found in benchmark)' : '';
            log += `\nThread ${thread.threadNo}: "${thread.spec}"${notInBenchmark}`;
        });

        logs.push(log);

        const filterDescriptions = {
            includingAny: ['onlyRunSpecFilesIncludingAnyText', 'only spec files that contain any strings from this array will be processed'],
            includingAll: ['onlyRunSpecFilesIncludingAllText', 'only spec files that contain all strings from this array will be processed'],
            notIncludingAny: ['onlyRunSpecFilesNotIncludingAnyText', 'only spec files that do not contain any strings from this array will be processed'],
            notIncludingAll: ['onlyRunSpecFilesNotIncludingAllText', 'only spec files that do not contain all strings from this array will be processed'],
        };

        Object.entries(filterDescriptions).forEach(([key, [optionName, description]]) => {
            const values = phase.textFilters[key];

            if (values) {
                const note = `For phase #${phase.phaseNo}, ${optionName} is set to ["${values.join('", "')}"]. Therefore, ${description}.`;
                logs.push(note);
                notes.push(note);
            }
        });
    });

    logs.unshift(`${threadCount} thread${threadCount !== 1 ? 's' : ''} will be created to test the following spec files in the following order:`);

    if (plan.phases.length > 1) {
        logs.push(settings.stopSubsequentPhasesOnFail
            ? 'Should tests in any phase fail, all threads from subsequent phases will stop immediately.'
            : 'Should tests in any phase fail, threads from subsequent phases will continue to run as stopSubsequentPhasesOnFail is set to false.');
    }

    logs.push(`A maximum of ${Math.min(threadCount, settings.maxConcurrentThreads)} threads will be used at any one time.\nThis code is executing on a machine with ${cpuCount} logical CPU threads.`);

    return { logs, notes };
};

/**
 * The (phase, spec) pairs that need their tests discovering
 */
const discoveryItems = (plan) => {
    const seen = new Set();
    const items = [];

    const add = (phase, spec) => {
        const key = `${phase.phaseNo}:${path.resolve(spec)}`;

        if (!seen.has(key)) {
            seen.add(key);
            items.push({ phase, spec });
        }
    };

    plan.threads.forEach((thread) => add(thread.phase, thread.spec));
    plan.phases.forEach(({ phase, assumedPassedSpecs }) => assumedPassedSpecs.forEach((spec) => add(phase, spec)));

    return items;
};

module.exports = {
    buildRunPlan,
    describeRunPlan,
    discoveryItems,
    isPhaseSkippedByUser,
};
