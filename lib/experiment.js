// maxConcurrentThreadsExperiment: runs the whole suite with different maxConcurrentThreads values and
// compares how long each took

const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { normaliseSettings } = require('./config/settings');
const { runInChildProcess } = require('./runSync');
const { green, calcTimeDifference, generatePercentageBar, escapeHtml } = require('./util/format');

const listDir = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.resolve(dir, name)) : []);

/**
 * Move everything a run produced into the experiment's own directories
 */
const archiveRunOutput = (reportDir, experiment, ignorePaths) => {
    listDir(reportDir).filter((src) => !ignorePaths.includes(src)).forEach((src) => {
        const destination = path.basename(src) === 'allure-report'
            ? experiment.allureDirAbs
            : path.join(experiment.dirAbs, path.basename(src));

        fs.moveSync(src, destination, { overwrite: true });
    });
};

const experimentLine = (experiment, index, longest, linkToReport) => {
    const percentage = (experiment.timeTaken / longest) * 100;

    const reportFile = fs.existsSync(path.join(experiment.allureDirAbs, 'complete.html')) ? 'complete.html' : 'index.html';
    const label = linkToReport
        ? `<a href="./${path.join(experiment.allureDirRel, reportFile)}">Experiment #${index + 1}</a>`
        : `Experiment #${index + 1}`;

    const details = `${generatePercentageBar(percentage, experiment.timeTaken)}\n${experiment.summary}\nStarted: ${experiment.timeStarted}\nFinished: ${experiment.timeFinished}\n\n`;

    return { text: `Experiment #${index + 1}: ${details}`, html: `${label}: ${linkToReport ? escapeHtml(details) : details}` };
};

/**
 * @param {object} config the merged config
 */
const runMaxConcurrentThreadsExperiment = (config) => {
    const settings = normaliseSettings(config);
    const { maxConcurrentThreadsArray = [], repeat = 3 } = settings.maxConcurrentThreadsExperiment;

    if (!maxConcurrentThreadsArray.length) {
        process.exit(1);
    }

    console.log(`Max concurrent threads experiment is active.\n\nAll experiments will be wrapped in a try/catch.\nMax concurrent threads array: ${maxConcurrentThreadsArray}\nEach experiment will run ${repeat} time(s)\n`);

    const ignorePaths = [];
    const results = maxConcurrentThreadsArray.map((maxConcurrentThreads, arrayIndex) => {
        console.log(`Start of ${maxConcurrentThreads} max concurrent threads experiment(s)`);

        return Array.from({ length: repeat }, (_, i) => {
            const experiment = {
                timeStarted: new Date(),
                summary: '',
                allureDirRel: `cmre_${maxConcurrentThreads}_${i}_allure-report`,
                dirAbs: path.resolve(settings.reportDir, `cmre_${maxConcurrentThreads}_${i}`),
                allureDirAbs: path.resolve(settings.reportDir, `cmre_${maxConcurrentThreads}_${i}_allure-report`),
            };

            const started = performance.now();

            try {
                runInChildProcess({
                    ...config,
                    allureReportDir: null,
                    clean: settings.clean && !i && !arrayIndex,
                    maxConcurrentThreadsExperimentInProg: true,
                    maxConcurrentThreads,
                    saveThreadBenchmark: false,
                    overwriteAllureHistory: false,
                    jUnitReport: config.jUnitReport ? { ...config.jUnitReport, browserStackTestObservabilityUpload: null } : config.jUnitReport,
                });
            } catch (err) {
                // experiments are allowed to fail
            }

            experiment.timeTaken = calcTimeDifference(performance.now(), started);
            experiment.timeFinished = new Date();

            const summaryFile = path.join(settings.reportDir, 'thread-performance-summary.txt');

            if (fs.existsSync(summaryFile)) {
                experiment.summary = fs.readFileSync(summaryFile, 'utf8');
            }

            ignorePaths.push(experiment.dirAbs, experiment.allureDirAbs);
            archiveRunOutput(settings.reportDir, experiment, ignorePaths);

            return experiment;
        });
    });

    const longest = Math.max(...results.flat().map((experiment) => experiment.timeTaken));

    let text = `\n${settings.heading}\n\nMax concurrent threads experiment results:\n\n`;
    let html = text;

    maxConcurrentThreadsArray.forEach((maxConcurrentThreads, index) => {
        const heading = `===========================\n${maxConcurrentThreads} max concurrent thread(s):\n===========================\n`;
        text += heading;
        html += heading;

        results[index].forEach((experiment, experimentIndex) => {
            const line = experimentLine(experiment, experimentIndex, longest, settings.generateAllure);
            text += line.text;
            html += line.html;
        });
    });

    if (settings.generateAllure) {
        html += 'The Allure reports can be accessed at the links above';
    }

    console.log(text);

    let htmlPath = path.resolve(settings.reportDir, 'index.html');

    fs.writeFileSync(htmlPath, `<!DOCTYPE html>
<html>
<head>
   <meta charset="utf-8">
   <title>Cypress Multithreaded Runner - Max concurrent threads experiment results</title>
</head>
<body style="margin:0;">
  <pre style="padding:15px;margin:0;">${html}</pre>
</body>
</html>`);

    if (settings.allureReportDir !== settings.defaultAllureReportDir) {
        listDir(settings.reportDir)
            .filter((src) => path.basename(src).includes('allure-report') || path.basename(src) === 'index.html')
            .forEach((src) => fs.moveSync(src, path.resolve(settings.allureReportDir, path.basename(src)), { overwrite: true }));

        htmlPath = path.resolve(settings.allureReportDir, 'index.html');
    }

    console.log(green(`The HTML report for these experiments ${settings.generateAllure ? '(including all Allure reports) ' : ''}can be accessed at: "${htmlPath}"`));

    if (settings.openAllure) {
        spawn(process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open'), [htmlPath], { detached: true, stdio: 'ignore' }).unref();
    } else {
        console.log('Passing through the arg --open will open the HTML report as soon as the tests have finished running');
    }
};

module.exports = {
    runMaxConcurrentThreadsExperiment,
};
