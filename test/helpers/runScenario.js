// Runs the real runner (and therefore real Cypress) against the fixture project in a child process

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { createTempDir } = require('./tempDir');
const { readJsonSafe, getFiles } = require('../../lib/util/fs');
const { keepDirectory } = require('./artifacts');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_PROJECT = path.join(__dirname, '..', 'fixtures', 'cypress-project');

/**
 * @param {string} name the test's title. Identifies the scenario (its output is kept in
 * test-artifacts/integration/runner/<name>) and is used as the heading of the Allure report
 * @param {object} config runner config (reportDir etc. are filled in)
 * @param {object} [options]
 * @param {boolean} [options.sync] use the synchronous API (index.js) instead of async.js
 * @param {string} [options.historyDir] share Allure history with other runs that use the same directory
 */
const runScenario = (name, config, { sync = false, historyDir } = {}) => new Promise((resolve, reject) => {
    const temp = createTempDir();
    const reportDir = temp.file('report');
    const benchmarkFile = temp.file('benchmarks.json');

    const fullConfig = {
        // the test's title is shown as the heading of the Allure report
        allureReportHeading: name,
        ...(historyDir ? { allureHistoryDir: historyDir } : {}),
        reportDir,
        threadBenchmarkFilepath: benchmarkFile,
        notify: false,
        endProcessIfTestsFail: false,
        threadDelay: 0,
        maxConcurrentThreads: 3,
        ...config,
    };

    const script = sync
        ? `require(${JSON.stringify(path.join(ROOT, 'index.js'))})(${JSON.stringify(fullConfig)});`
        : `require(${JSON.stringify(path.join(ROOT, 'async.js'))})(${JSON.stringify(fullConfig)}).then((code) => console.log('CMR_EXIT_CODE=' + code));`;

    const child = spawn(process.execPath, ['-e', script], {
        cwd: FIXTURE_PROJECT,
        env: { ...process.env, NO_COLOR: '1' },
    });

    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.on('error', reject);

    child.on('close', (processExitCode) => {
        const allureResultsDir = path.join(reportDir, 'allure-results');
        const allureReportDir = path.join(reportDir, 'allure-report');
        const benchmarks = readJsonSafe(benchmarkFile, {});
        const exitCodeMatch = output.match(/CMR_EXIT_CODE=(\d+)/);

        resolve({
            output,
            processExitCode,
            exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : processExitCode,
            reportDir,
            temp,
            benchmark: Object.values(benchmarks)[0],
            allureStatistic: readJsonSafe(path.join(allureReportDir, 'widgets', 'summary.json'), {})?.statistic,
            results: getFiles(allureResultsDir).filter((file) => file.endsWith('-result.json')).map((file) => fs.readJsonSync(file)),
            cmrSummary: readJsonSafe(path.join(allureReportDir, 'cmr-summary.json')),
            reportHtml: fs.existsSync(path.join(allureReportDir, 'index.html')) ? fs.readFileSync(path.join(allureReportDir, 'index.html'), 'utf8') : '',
            readReportFile: (relative) => fs.readFileSync(path.join(reportDir, relative), 'utf8'),
            // keeps everything the run produced (reports, results, logs, benchmark, console output) for inspection
            cleanup: () => {
                fs.writeFileSync(temp.file('console-output.log'), output);
                keepDirectory({ kind: 'integration', suite: 'runner', name }, temp.dir);
                temp.cleanup();
            },
        });
    });
});

const generatedResults = (results) => results.filter((result) => result.statusDetails?.message?.includes('Added by Cypress Multithreaded Runner'));

module.exports = {
    runScenario,
    generatedResults,
    FIXTURE_PROJECT,
};
