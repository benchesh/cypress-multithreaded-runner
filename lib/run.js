// The runner: plans the threads, discovers every test, runs Cypress, then builds the reports

const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const notifier = require('node-notifier');

const { normaliseSettings } = require('./config/settings');
const { resolveSpecSelection } = require('./specs/specSelection');
const { buildRunPlan, describeRunPlan, discoveryItems, isPhaseSkippedByUser } = require('./specs/runPlan');
const { TestDiscovery } = require('./discovery/discoverTests');
const { buildCypressArgs } = require('./cypress/cypressArgs');
const { CypressProcess, resolveCypressBinary, supportsExposeFlag } = require('./cypress/cypressProcess');
const { Outcome, INCOMPLETE_OUTCOMES } = require('./threads/Thread');
const { LogPrinter } = require('./threads/LogPrinter');
const { ThreadPool } = require('./threads/ThreadPool');
const { runWithRetries } = require('./threads/runWithRetries');
const { AllureResultsStore } = require('./allure/results');
const { generateAllureReport, hostAllureReport, isJavaInstalled } = require('./allure/allureCli');
const { buildReportHeader, buildReportFooter, injectIntoReport } = require('./allure/html/reportHtml');
const { resolveThreadOutcomes, assumedPassedOutcomes, computeTestStats, hasFailures } = require('./report/testOutcomes');
const { buildThreadReport } = require('./report/threadReport');
const benchmark = require('./report/benchmark');
const { processJUnitReports, threadJUnitFile } = require('./report/junit');
const { resolveCustomLogs } = require('./report/customLogs');
const { createSpecUrlResolver, createSpecLinker } = require('./report/specLinks');
const {
    green, orange, red, cyan, pluralise, arrToNaturalStr, secondsToNaturalString, calcTimeDifference,
} = require('./util/format');
const {
    mkdirSyncIfMissing, writeFileSyncRecursive, writeJsonSyncRecursive, getFiles, deleteEmptyFoldersRecursively,
} = require('./util/fs');

const NOT_RUN_MESSAGE = (source) => `This spec file wasn't run, as only the spec files that failed in ${source} were run.`;
const ASSUMED_PASSED_MESSAGE = (source) => `${NOT_RUN_MESSAGE(source)} This test is therefore assumed to have passed previously and has been marked as skipped in this report. Added by Cypress Multithreaded Runner.`;
const ASSUMED_SKIPPED_MESSAGE = (source) => `${NOT_RUN_MESSAGE(source)} This test is skipped anyway. Added by Cypress Multithreaded Runner.`;

class Run {
    /**
     * @param {object} config the merged config (see mergeCliOverrides)
     * @param {object} [options]
     * @param {string} [options.cwd] the Cypress project root
     */
    constructor(config, { cwd = process.cwd() } = {}) {
        this.settings = normaliseSettings(config);
        this.cwd = cwd;
        this.startTime = performance.now();
        this.timestamp = Date.now();
    }

    verboseLog(...msg) {
        if (this.settings.verbose) {
            console.log(cyan(msg.join(' ')));
        }
    }

    notify(message) {
        if (this.settings.notify && !this.settings.maxConcurrentThreadsExperimentInProg) {
            notifier.notify({ title: 'Cypress Multithreaded Runner', message, sound: true });
        }
    }

    abort(message) {
        console.error(red(`CRITICAL ERROR: ${message}`));
        this.notify(message);
        process.exit(1);
    }

    /**
     * @returns {Promise<number>} the exit code: 0 if every test passed, otherwise 1
     */
    async execute() {
        const { settings } = this;

        console.log(settings.heading);

        if (settings.generateAllure && !isJavaInstalled()) {
            this.abort('Java is not installed or not in the PATH. Java is currently required to generate the Allure report.\nhttps://www.java.com/en/download/');
        }

        if (settings.maxConcurrentThreadsExperiment && !settings.maxConcurrentThreadsExperimentInProg) {
            console.warn(orange('WARNING: maxConcurrentThreadsExperiment will not work when run through the async mode'));
        }

        this.selection = await resolveSpecSelection(settings);
        this.plan(settings);
        await this.discoverTests();
        this.prepareReportDir();
        await this.runThreads();
        this.resolveTestOutcomes();
        this.buildThreadReport();

        if (settings.generateAllure) {
            await generateAllureReport({ reportDir: settings.reportDir, combine: settings.combineAllure, verboseLog: (str) => this.verboseLog(str) });
        }

        this.exitCode = this.computeExitCode();
        this.saveBenchmark();

        this.browserStackObservabilityURL = settings.jUnitReport
            ? await processJUnitReports({ reportDir: settings.reportDir, jUnitReport: settings.jUnitReport, allureReportDir: settings.defaultAllureReportDir })
            : null;

        this.updateAllureHistory();
        this.printCustomLogs();
        await this.finaliseAllureReport();
        this.cleanUp();

        this.notify(this.exitCode === 0 ? 'Tests completed (all passed)' : 'Tests completed (with failures)');

        if (settings.endProcessIfTestsFail && this.exitCode) {
            process.exit(this.exitCode);
        }

        return this.exitCode;
    }

    plan(settings) {
        this.benchmarks = benchmark.loadBenchmarks(settings.threadBenchmarkFilepath);
        this.benchmarkIdentity = benchmark.benchmarkIdentity(settings, this.selection.specFiles);
        this.benchmarkId = benchmark.benchmarkId(settings, this.benchmarkIdentity);

        const benchmarkOrder = this.benchmarks[this.benchmarkId]?.order;

        this.runPlan = buildRunPlan({ settings, selection: this.selection, benchmarkOrder });
        this.threads = this.runPlan.threads;

        this.runPlan.missingSpecFiles.forEach((specFile) => console.log(orange(`WARNING: "${specFile}" was not found in any test phase`)));

        const { logs, notes } = describeRunPlan({ settings, plan: this.runPlan, benchmarkOrder, cpuCount: os.cpus().length });
        this.reportNotes = notes;

        if (settings.repeat > 1) {
            logs.push(green(`Repeat is set to ${settings.repeat}. Therefore, all threads in all phases will run ${settings.repeat} times, regardless of whether the tests pass or fail.`));
        }

        if (settings.retryAllFailedSpecs) {
            logs.push(green(`retryAllFailedSpecs is set to ${settings.retryAllFailedSpecs}. Therefore, once all threads have completed, any failed threads will be retried (keeping their original thread numbers) up to ${pluralise(settings.retryAllFailedSpecs, 'time')}${settings.retryAllFailedSpecsDelay ? `, waiting ${secondsToNaturalString(settings.retryAllFailedSpecsDelay)} before each retry` : ''}.`));
        }

        if (!settings.saveThreadBenchmark) {
            logs.push(orange('saveThreadBenchmark is set to false, therefore the benchmark file will not be updated when this run completes.'));
        }

        console.log(`${logs.join('\n\n')}\n`);

        if (!this.threads.length) {
            this.abort('No spec files were found!');
        }
    }

    async discoverTests() {
        const started = performance.now();
        const discovery = new TestDiscovery({ cwd: this.cwd, verboseLog: (...msg) => this.verboseLog(...msg) });

        this.discoveries = await discovery.discoverAll(discoveryItems(this.runPlan));
        this.discoveryFor = (phaseNo, spec) => this.discoveries.get(TestDiscovery.key(phaseNo, spec));

        const all = [...this.discoveries.values()];
        const testCount = all.reduce((total, item) => total + item.tests.filter((test) => test.grepIncluded).length, 0);
        const estimated = all.filter((item) => item.estimated);

        estimated.forEach((item) => console.warn(orange(`WARNING: The tests in "${item.spec}" couldn't be counted accurately, as the spec file couldn't be evaluated (${item.error}). A text search was used instead, so tests created in loops may have been missed.`)));

        this.estimatedSpecs = estimated.map((item) => item.spec);

        console.log(`${pluralise(testCount, 'test')} found in ${pluralise(all.length, 'spec file')} (${secondsToNaturalString(calcTimeDifference(performance.now(), started))}).\n`);
    }

    prepareReportDir() {
        const { settings } = this;

        if (settings.clean) {
            fs.rmSync(settings.reportDir, { recursive: true, force: true });
        }

        // needed if a Cypress instance doesn't log anything but still wants to write to the report directory
        mkdirSyncIfMissing(settings.reportDir);

        if (
            settings.allureHistoryDir
            && settings.allureHistoryDir !== settings.defaultAllureHistoryDir
            && fs.existsSync(settings.allureHistoryDir)
        ) {
            fs.copySync(settings.allureHistoryDir, settings.defaultAllureHistoryDir, { overwrite: true });
        }
    }

    async runThreads() {
        const { settings } = this;
        const binary = resolveCypressBinary(this.cwd);
        const supportsExpose = supportsExposeFlag(binary);

        this.verboseLog(`Cypress ${binary.version || '(version unknown)'}; --expose ${supportsExpose ? 'is' : 'is not'} supported`);

        this.resultsStore = new AllureResultsStore({ allureResultsDir: settings.allureResultsDir, cwd: this.cwd, crashPatterns: settings.crashPatterns });

        const writeThreadLogs = (thread) => writeFileSyncRecursive(path.join(settings.reportDir, 'cypress-logs', `thread_${thread.threadNo}.txt`), thread.fullLogs);

        this.printer = new LogPrinter({ logMode: settings.logMode });

        this.pool = new ThreadPool({
            settings,
            phaseCount: settings.phases.length,
            printer: this.printer,
            resultsStore: this.resultsStore,
            verboseLog: (...msg) => this.verboseLog(...msg),
            processFactory: (thread) => new CypressProcess({
                binary,
                cwd: this.cwd,
                args: buildCypressArgs({
                    phase: thread.phase,
                    spec: thread.spec,
                    threadNo: thread.threadNo,
                    allureResultsDir: settings.allureResultsDir,
                    timestamp: this.timestamp,
                    jUnitFile: settings.jUnitReport ? threadJUnitFile(settings.reportDir, thread) : null,
                    supportsExpose,
                }),
            }),
            onThreadComplete: (thread) => {
                writeThreadLogs(thread);
                this.resultsStore.collect(thread);
            },
        });

        await runWithRetries({
            pool: this.pool,
            threads: this.threads,
            retries: settings.retryAllFailedSpecs,
            retryDelay: settings.retryAllFailedSpecsDelay,
        });

        // pick up anything left behind by threads that never completed normally
        this.threads.forEach((thread) => this.resultsStore.collect(thread));

        this.printer.printAllSeparately(this.threads);

        console.log(`All Cypress testing threads have ended after ${secondsToNaturalString(calcTimeDifference(performance.now(), this.startTime))}.`);
    }

    /**
     * Work out the outcome of every test, and add Allure results for tests that didn't produce any
     */
    resolveTestOutcomes() {
        this.threadOutcomes = new Map();

        this.threads.forEach((thread) => {
            const outcomes = resolveThreadOutcomes(thread, this.discoveryFor(thread.phaseNo, thread.spec), this.settings);

            outcomes.missing.forEach(({ test, status, message }) => {
                this.resultsStore.writeSyntheticResult({ spec: thread.spec, test, status, message });
            });

            this.threadOutcomes.set(thread.threadNo, outcomes);
        });

        this.assumedPassedSpecs = this.runPlan.phases.flatMap(({ phase, assumedPassedSpecs }) => assumedPassedSpecs.map((spec) => ({ phase, spec })));

        const assumedOutcomes = this.assumedPassedSpecs.flatMap(({ phase, spec }) => assumedPassedOutcomes(this.discoveryFor(phase.phaseNo, spec)).map((outcome) => {
            this.resultsStore.writeSyntheticResult({ spec, test: outcome.test, status: outcome.status, message: (outcome.assumedPassed ? ASSUMED_PASSED_MESSAGE : ASSUMED_SKIPPED_MESSAGE)(this.selection.source) });
            return outcome;
        }));

        this.allOutcomes = [...this.threadOutcomes.values()].flatMap((outcomes) => outcomes.tests).concat(assumedOutcomes);
        this.testStats = computeTestStats(this.allOutcomes);
    }

    buildThreadReport() {
        const { settings } = this;

        this.threadReport = buildThreadReport({
            threads: this.threads,
            threadOutcomes: this.threadOutcomes,
            settings,
            isPhaseSkipped: (phaseNo) => isPhaseSkippedByUser(settings, phaseNo),
            testStats: this.testStats,
            assumedPassedSpecCount: this.assumedPassedSpecs.length,
        });

        const { summary, reportText } = this.threadReport;

        console.log(`\n\n${summary}`);
        fs.writeFileSync(path.resolve(settings.reportDir, 'thread-performance-summary.txt'), summary);

        console.log(`\n\n${reportText}\n\n`);
        fs.writeFileSync(path.resolve(settings.reportDir, 'thread-performance-report.txt'), reportText);
    }

    threadsWithStatus(status) {
        return this.threads.filter((thread) => this.threadReport.entries.get(thread.threadNo)?.status === status);
    }

    computeExitCode() {
        return this.threadsWithStatus('error').length || hasFailures(this.allOutcomes) ? 1 : 0;
    }

    saveBenchmark() {
        const { settings } = this;
        const previous = this.benchmarks[this.benchmarkId];

        const { record, orderReason, orderChanged } = benchmark.buildBenchmarkRecord({
            identity: this.benchmarkIdentity,
            previous,
            threads: this.threads,
            failedSpecs: this.threadsWithStatus('error').map((thread) => thread.spec),
            testStats: this.testStats,
            timestamp: this.timestamp,
            customMetadata: settings.benchmarkCustomMetadata,
        });

        this.benchmarkRecord = record;

        if (!settings.saveThreadBenchmark) {
            return;
        }

        if (orderReason) {
            console.log(orange(`The thread order in the benchmark file won't be updated because ${orderReason}!`));
        } else if (orderChanged) {
            console.log(`Updating thread order:\n["${record.order.join('", "')}"]`);
        } else {
            console.log('The results of the thread benchmark are identical to the records already saved; the thread order doesn\'t need changing!');
        }

        benchmark.saveBenchmark(settings.threadBenchmarkFilepath, this.benchmarks, this.benchmarkId, record);
        console.log(`Benchmark file updated: ${settings.threadBenchmarkFilepath}`);
    }

    updateAllureHistory() {
        const { settings } = this;
        const historyDir = path.resolve(settings.defaultAllureReportDir, 'history');

        if (!fs.existsSync(historyDir)) {
            return;
        }

        getFiles(historyDir).filter((file) => file.endsWith('.json')).forEach((file) => {
            try {
                writeJsonSyncRecursive(file, JSON.parse(fs.readFileSync(file, 'utf8')));
            } catch {
                console.warn(orange(`WARNING: Failed to parse Allure history file "${file}"`));
            }
        });

        if (settings.overwriteAllureHistory && settings.allureHistoryDir) {
            fs.copySync(historyDir, settings.allureHistoryDir, { overwrite: true });
        }
    }

    printCustomLogs() {
        this.customLogs = resolveCustomLogs(this.settings.customLogs);
        // they're always included in the Allure report, so they're only printed when verbose logs are enabled
        this.customLogs.forEach(({ heading, content }) => this.verboseLog(`${heading}\n\n${content}`));
    }

    /**
     * The message shown at the top of the Allure report when threads didn't complete
     */
    incompleteThreadsHtml() {
        const incomplete = this.threads.filter((thread) => INCOMPLETE_OUTCOMES[thread.outcome]);

        if (!incomplete.length) {
            return null;
        }

        const { settings } = this;
        const threadList = (threads) => arrToNaturalStr(threads.map((thread) => `#${thread.threadNo}`));
        const withOutcome = (...outcomes) => incomplete.filter((thread) => outcomes.includes(thread.outcome));

        const crashed = withOutcome(Outcome.CRASHED, Outcome.ABORTED);
        const timedOut = withOutcome(Outcome.TIMED_OUT);
        const stopped = withOutcome(Outcome.STOPPED, Outcome.NOT_RUN);

        const parts = [];

        if (this.pool.timeoutCount > settings.maxAllowedTimeouts) {
            parts.push(`${pluralise(this.pool.timeoutCount, 'thread')} timed out, which is more than the allowed limit. When this limit was surpassed, all incomplete threads stopped running immediately.`);
        }

        if (stopped.length) {
            parts.push(`One or more tests in <span style="font-weight: bold;">phase #${this.pool.phaseLock || '?'} failed</span>, therefore thread ${threadList(stopped)} from subsequent phases didn't complete.`);
        }

        if (crashed.length) {
            parts.push(`<span style="font-weight: bold;">Thread ${threadList(crashed)} had ${crashed.length > 1 ? 'critical errors' : 'a critical error'}</span> and didn't complete!`);
        }

        if (timedOut.length) {
            parts.push(`<span style="font-weight: bold;">Thread ${threadList(timedOut)} ${timedOut.length > 1 ? 'were' : 'was'} stopped early</span> because ${timedOut.length > 1 ? 'they each' : 'it'} failed to complete within the maximum time limit of ${secondsToNaturalString(settings.threadTimeLimit)}.`);
        }

        const filled = [...this.threadOutcomes.values()].flatMap((outcomes) => outcomes.missing);
        const filledCounts = ['broken', 'failed', 'skipped']
            .map((status) => [status, filled.filter((item) => item.status === status).length])
            .filter(([, count]) => count)
            .map(([status, count]) => `${count} as ${status}`);

        parts.push(filled.length
            ? `The ${pluralise(filled.length, 'test')} in these threads that didn't produce results ${filled.length === 1 ? 'has' : 'have'} been added to this report (${filledCounts.join(', ')}), so the number of tests in this report is complete. However, the results for the affected spec files may be inaccurate, as those tests didn't get the chance to run properly.`
            : 'Every test in these threads produced a result before the thread stopped, so the number of tests in this report is complete.');

        return parts.join('<br><br>');
    }

    /**
     * Links the spec files mentioned in the report's header and footer to their repo (see includeRepoPath)
     */
    specLinker() {
        const { includeRepoPath } = this.settings;
        const urlFor = createSpecUrlResolver({ includeRepoPath, cwd: this.cwd, warn: (msg) => console.warn(orange(msg)) });
        const specs = [...new Set([...this.threads.map((thread) => thread.spec), ...this.estimatedSpecs])];
        const specUrls = new Map(specs.map((spec) => [spec, urlFor(spec)]));
        const linked = [...specUrls.values()].filter(Boolean).length;

        if (includeRepoPath) {
            this.verboseLog(linked
                ? `${pluralise(linked, 'spec file')} in the Allure report will link to the repo, e.g. ${[...specUrls.values()].find(Boolean)}`
                : 'The spec files in the Allure report won\'t link to a repo, as they aren\'t in a git repo with a remote');
        }

        return createSpecLinker(specUrls);
    }

    reportNotesWithExtras() {
        const notes = [...this.reportNotes];

        if (this.assumedPassedSpecs.length) {
            notes.push(`Only the spec files that failed in ${this.selection.source} were run. The other ${pluralise(this.assumedPassedSpecs.length, 'spec file')} (${pluralise(this.testStats.assumedPassed, 'test')}) weren't run. Their tests are assumed to have passed previously, and have been added to this report as skipped.`);
        }

        if (this.estimatedSpecs.length) {
            notes.push(`The tests in ${pluralise(this.estimatedSpecs.length, 'spec file')} couldn't be counted accurately (${this.estimatedSpecs.join(', ')}), so if any of them didn't complete, the number of tests in this report may be inaccurate.`);
        }

        return notes;
    }

    async finaliseAllureReport() {
        const { settings } = this;

        const runConfig = {
            browserStackObservabilityURL: this.browserStackObservabilityURL,
            summary: this.threadReport.summary,
            ...this.benchmarkRecord,
        };

        const indexHtml = path.resolve(settings.defaultAllureReportDir, 'index.html');

        if (!settings.generateAllure || !fs.existsSync(indexHtml)) {
            writeJsonSyncRecursive(path.resolve(settings.reportDir, 'cmr-summary.json'), runConfig);
            return;
        }

        const { entries } = this.threadReport;
        const status = this.threadsWithStatus('error').length ? 'error' : (this.threadsWithStatus('warn').length ? 'warn' : 'success');
        const criticalHtml = this.incompleteThreadsHtml();
        const isIncomplete = (thread) => Boolean(INCOMPLETE_OUTCOMES[thread.outcome]);
        const linkSpecs = this.specLinker();

        const header = buildReportHeader({
            heading: settings.heading,
            status,
            runConfig,
            criticalHtml,
            errors: this.threadsWithStatus('error').filter((thread) => !isIncomplete(thread)).map((thread) => entries.get(thread.threadNo).summary).filter(Boolean),
            warnings: this.threadsWithStatus('warn').map((thread) => entries.get(thread.threadNo).summary).filter(Boolean),
            notes: this.reportNotesWithExtras(),
            browserStackObservabilityURL: this.browserStackObservabilityURL,
            timestamp: this.timestamp,
            linkSpecs,
        });

        const footer = buildReportFooter({
            customLogs: this.customLogs,
            threads: this.threads.map((thread) => ({ ...entries.get(thread.threadNo), logsTimestamped: thread.logsTimestamped })),
            performanceSummary: [this.threadReport.summary, this.threadReport.reportText].filter(Boolean).join('\n\n'),
            expandHeader: Boolean(criticalHtml),
            linkSpecs,
        });

        const completeHtml = path.resolve(settings.defaultAllureReportDir, 'complete.html');
        let combinedSuccessfully = false;

        if (settings.combineAllure) {
            try {
                fs.moveSync(path.resolve(settings.reportDir, 'allure-report-temp', 'index.html'), completeHtml, { overwrite: true });
                injectIntoReport(completeHtml, header, footer);
                console.log(green(`The Allure report for this run has been bundled into a single HTML file: "${path.resolve(settings.allureReportDir, 'complete.html')}"`));
                combinedSuccessfully = true;
            } catch {
                console.log(red('Error when attempting to bundle the Allure report into a single file!'));
            }
        }

        injectIntoReport(indexHtml, header, footer);

        if (settings.allureReportDir !== settings.defaultAllureReportDir) {
            fs.moveSync(settings.defaultAllureReportDir, settings.allureReportDir, { overwrite: true });
        }

        writeJsonSyncRecursive(path.resolve(settings.allureReportDir, 'cmr-summary.json'), runConfig);
        console.log(green(`The Allure report for this run has been saved to the following directory: "${settings.allureReportDir}"`));

        if (settings.maxConcurrentThreadsExperimentInProg) {
            return;
        }

        if (settings.hostAllure) {
            await hostAllureReport(settings.allureReportDir);
        } else if (settings.openAllure) {
            const reportFile = path.resolve(settings.allureReportDir, combinedSuccessfully ? 'complete.html' : 'index.html');
            require('child_process').spawn(process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open'), [reportFile], { detached: true, stdio: 'ignore' }).unref();
        } else {
            console.log('Passing through the arg --open will open the Allure report as soon as the tests have finished running');
        }
    }

    cleanUp() {
        const { settings } = this;

        deleteEmptyFoldersRecursively(settings.reportDir);

        if (settings.waitForFileExist?.deleteAfterCompletion && fs.existsSync(settings.waitForFileExist.filepath)) {
            fs.unlinkSync(settings.waitForFileExist.filepath);
        }

        if (this.browserStackObservabilityURL) {
            console.log(green(`View the BrowserStack Test Observability report here: "${this.browserStackObservabilityURL}"`));
        }
    }
}

/**
 * @param {object} config the merged config (see mergeCliOverrides)
 * @param {object} [options]
 * @returns {Promise<number>} the exit code
 */
const run = (config, options) => new Run(config, options).execute();

module.exports = {
    run,
    Run,
};
