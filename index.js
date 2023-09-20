module.exports = (config = {}) => {
    const yargs = require('yargs/yargs');
    const { hideBin } = require('yargs/helpers');
    const fs = require('fs-extra');

    const path = require('path');

    const { argv } = yargs(hideBin(process.argv));

    const fullConfig = { ...config, ...argv };

    const { execSync, spawn } = require('child_process');

    const kill = require('tree-kill');

    const cypressConfigFilepath = fullConfig.cypressConfig?.filepath ? path.resolve(fullConfig.cypressConfig.filepath) : null;
    const cypressConfigObject = fullConfig.cypressConfig?.object;
    const reportDir = fullConfig.reportDir ? path.join(fullConfig.reportDir) : null;
    const specsDir = fullConfig.specsDir ? path.resolve(fullConfig.specsDir) : null;
    const maxThreadRestarts = fullConfig.maxThreadRestarts || 5;

    const runShellCommand = (cmd) => {
        execSync(cmd, {
            cwd: path.resolve(reportDir),
            stdio: [null, process.stdout, process.stderr],
        });
    };

    const getDirectories = (srcpath) => (
        fs.existsSync(srcpath) ? fs.readdirSync(srcpath) : []
    ).map((file) => path.join(srcpath, file))
        .filter((filepath) => fs.statSync(filepath).isDirectory());

    const getFiles = (srcpath) => (
        fs.existsSync(srcpath) ? fs.readdirSync(srcpath) : []
    ).map((file) => path.join(srcpath, file))
        .filter((filepath) => !fs.statSync(filepath).isDirectory());

    let exitCode = 0;

    const wordpressTestThreadDirs = fullConfig.singleThread ? [specsDir] : getDirectories(specsDir);

    if (!wordpressTestThreadDirs.length) {
        console.error('CRITICAL ERROR: No test directories were found!');
        process.exit(1);
    }

    if (getFiles(specsDir).length) {
        console.warn(`WARNING: One or more files have been placed at the root of ${specsDir}. All spec files must be in subdirectories, otherwise they will not get tested when run in multithreaded mode:\n${getFiles(specsDir).join('\n')}\n`);
    }

    // a basic CSV for recording how many seconds each thread took to run
    const threadPerformanceFilepath = path.join(reportDir, 'thread-performance.csv');

    // raw test results are saved to this directory, which are then used to create the allure report
    const allureResultsPath = path.join(reportDir, 'allure-results');

    // add a custom config to every thread to pass into the shell script
    const testThreads = wordpressTestThreadDirs.map((dir) => JSON.stringify({
        ...cypressConfigObject,
        specPattern: dir,
    }));

    console.log(`${testThreads.length} thread${testThreads.length !== 1 ? 's' : ''} will be created to test spec files in the following director${testThreads.length !== 1 ? 'ies' : 'y'}:\n${wordpressTestThreadDirs.join('\n')}\n`);

    (async () => {
        let restartAttempts = 0;

        async function runCypressTests() {
            let restartTests = false;

            const cypressProcess = spawn('bash', [
                path.resolve(__dirname, 'shell.sh'),
                // arguments for the shell script
                threadPerformanceFilepath || '',// $1
                allureResultsPath || '',// $2
                cypressConfigFilepath || '',// $3
                fullConfig.waitForFileExist?.filepath || '',// $4
                fullConfig.waitForFileExist?.timeout || 60,// $5
            ].concat(
                testThreads, // $6 + every additional thread is passed as an extra argument
            ));

            // detect known internal errors and restart the tests when they occur!
            const logCheck = async (log) => {
                if (
                    log.includes('uncaught error was detected outside of a test')
                    || log.includes('we are skipping the remaining tests in the current suite')
                    || log.includes('Cypress could not associate this error to any specific test.')
                ) {
                    restartTests = true;

                    kill(cypressProcess.pid);
                }
            };

            cypressProcess.stdout.on('data', (data) => {
                process.stdout.write(data);
                logCheck(data.toString());
            });

            cypressProcess.stderr.on('data', (data) => {
                process.stderr.write(data);
                logCheck(data.toString());
            });

            return new Promise((resolve) => {
                cypressProcess.on('close', async (code) => {
                    if (restartTests) {
                        setTimeout(async () => {
                            restartAttempts += 1;

                            if (restartAttempts < maxThreadRestarts) {
                                console.warn(
                                    `WARNING: Internal Cypress error! Will retry a maximum of ${maxThreadRestarts - restartAttempts} more time${(maxThreadRestarts - restartAttempts) !== 1 ? 's' : ''}.`,
                                );

                                // delete any test results as they'll interfere with the next run
                                fs.rmSync(reportDir, { recursive: true, force: true });

                                await runCypressTests(code);
                            } else {
                                console.error(
                                    `CRITICAL ERROR: Too many internal Cypress errors. Giving up after ${maxThreadRestarts} attempts!`,
                                );
                                process.exit(1);
                            }

                            resolve();
                        }, 1000);
                    } else {
                        resolve();
                    }
                });
            });
        }

        await runCypressTests();

        // bulk of multithread report logic
        if (wordpressTestThreadDirs.length > 1) {
            const secondsToNaturalString = (seconds) => {
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds - (minutes * 60);

                return `${minutes ? `${minutes} minutes, ` : ''}${remainingSeconds} seconds`;
            };

            const threadPerformanceResults = {};

            let longestThread = { secs: 0 };

            // needed to sort the csv in order of thread id
            const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

            fs.readFileSync(threadPerformanceFilepath)
                .toString('utf8')
                .trim()
                .split('\n')
                .sort(collator.compare)
                .forEach((csvRow, index) => {
                    const secs = Number(csvRow.split(',')[1]);

                    const failedTests = {};

                    // record how many tests failed, and how many times!
                    getFiles(
                        path.join(allureResultsPath, String(index + 1)),
                    ).forEach((file) => {
                        if (file.endsWith('.json')) {
                            const { status, labels, fullName } = fs.readJsonSync(file);

                            if (
                                status
                                && labels
                                && fullName
                                && !['passed', 'skipped'].includes(status)
                            ) {
                                // ensure the key is wholly unique (in case two tests have the same title)
                                const key = `${fullName}${JSON.stringify(labels)}`;

                                if (!failedTests[key]) failedTests[key] = 1;
                                else failedTests[key] += 1;
                            }
                        }

                        // files from all threads need to be in the same directory to construct the allure report
                        fs.moveSync(
                            file,
                            path.resolve(allureResultsPath, path.basename(file)),
                            { overwrite: true },
                        );
                    });

                    // extract the thread id from the csv and store the records
                    threadPerformanceResults[Number(csvRow.split(',')[0]) - 1] = {
                        failedTests,
                        naturalString: secondsToNaturalString(secs),
                        secs,
                    };

                    // the longest thread is used as the basis of comparison with the others
                    if (secs > longestThread.secs) {
                        longestThread = {
                            index,
                            naturalString: secondsToNaturalString(secs),
                            secs,
                        };
                    }
                });

            // a visual representation of how each thread performed, to show where any bottlenecks lie
            const generateThreadBars = (totalTime) => {
                let str = '';

                wordpressTestThreadDirs.forEach((threadPath, index) => {
                    const threadId = testThreads.length > 9 ? String(index + 1).padStart(2, '0') : index + 1;

                    str += `Thread #${threadId} [${threadPath}]\n`;

                    // if there's a very high number of threads, they're prone to ending early
                    if (!threadPerformanceResults[index]) {
                        str += 'CRITICAL ERROR: Thread did not complete!\n\n';
                        exitCode = 1;
                        return;
                    }

                    const percentageOfTotal = (
                        threadPerformanceResults[index].secs / totalTime
                    ) * 100;

                    const percentageBar = `${Array.from({ length: Math.round(percentageOfTotal / 2) }, () => '█').concat(
                        Array.from({ length: 50 - Math.round(percentageOfTotal / 2) }, () => '░'),
                    ).join('')}`;

                    // log if any tests in the thread failed/retried
                    const reportFailedTests = (obj) => {
                        if (!Object.entries(obj).length) {
                            return '';
                        }

                        const counts = Object.values(obj).reduce((acc, curr) => {
                            acc[curr] = (acc[curr] || 0) + 1;
                            return acc;
                        }, {});

                        const result = [];
                        Object.keys(counts).sort((a, b) => b - a).forEach((num) => {
                            result.push(`${counts[num]} test${counts[num] > 1 ? 's' : ''} failed ${num} time${num > 1 ? 's' : ''}`);
                        });

                        return ` (WARNING: ${result.join(', ')})`;
                    };

                    str += `${percentageBar} ${percentageOfTotal.toFixed(2)}% (${threadPerformanceResults[index].naturalString})${reportFailedTests(threadPerformanceResults[index].failedTests)}\n\n`;
                });

                return str;
            };

            const reportText = `See below to compare how each thread is performing.\n\n${generateThreadBars(longestThread.secs)}The percentages given above represent how much time individual threads take relative to thread #${longestThread.index + 1}, which took the longest to complete at ${longestThread.naturalString}. Any thread that takes significantly longer than others will be a bottleneck, so the closer the percentages are to one another, the better. A wide range in percentages indicates that the threads could be balanced more efficiently. Any failing tests will retry up to two more times, so in those instances the affected threads will take much longer to complete than if all tests passed on the first attempt.`;

            console.log(`\n\n${reportText}\n\n`);

            // save these logs for future reference!
            fs.writeFileSync(`${reportDir}thread-performance-report.txt`, reportText);
        }

        // Overwrite the historyIds in the allure results, as the allure plugin's method is flawed.
        // Doing this ensures tests across identical names are included in the report (see FAB-46674)
        // NOTE: Tests with identical names must be in different describe blocks and/or spec files
        getFiles(allureResultsPath).forEach((file) => {
            if (!file.endsWith('.json')) return;

            const data = fs.readJsonSync(file);

            const { labels, fullName } = data;

            if (data.historyId && labels.length) {
                data.historyId = Buffer.from(JSON.stringify(labels.concat(fullName))).toString('base64');

                fs.writeFileSync(file, JSON.stringify(data));
            }
        });

        // generate the allure report from the most recent run
        runShellCommand('allure generate allure-results --clean -o allure-report');

        // make sure none of the tests failed!
        if (!exitCode) {
            const testResultsObj = fs.readJsonSync(
                path.resolve(reportDir, 'allure-report', 'history', 'history-trend.json'),
                'utf-8',
            )[0].data;

            if (
                testResultsObj.failed
                + testResultsObj.broken
                + testResultsObj.unknown !== 0
            ) {
                exitCode = 1;
            }
        }

        const allureReportHtml = path.resolve(reportDir, 'allure-report', 'index.html');

        // hack to remove some dodgy html that breaks allure-combine
        if (fs.existsSync(allureReportHtml)) {
            fs.writeFileSync(
                allureReportHtml,
                fs.readFileSync(allureReportHtml)
                    .toString('utf8').replace(/.*(googletagmanager|gtag|dataLayer|<script>|\n<\/script>).*/gm, '')
            )
        }

        if (fullConfig.waitForFileExist?.deleteAfterCompletion) {
            if (fs.existsSync(fullConfig.waitForFileExist.filepath)) {
                fs.unlinkSync(fullConfig.waitForFileExist.filepath);
            }
        }

        if (fullConfig.allureReportDir) {
            fs.moveSync(
                path.resolve(reportDir, 'allure-report'),
                path.resolve(fullConfig.allureReportDir),
                { overwrite: true },
            );
        }

        if (!fullConfig.skipAllureCombine) {
            try {
                runShellCommand('pip install allure-combine && allure-combine allure-report');

                if (fullConfig.openAllure) {
                    runShellCommand('open allure-report/complete.html');
                }

                console.log(`\x1b[32mThe allure report for this run has been bundled into a single HTML file: "${reportDir}allure-report/complete.html"`);
            } catch (err) {
                console.log('Error when attempting to bundle the allure report into a single file :( You might not have pip installed. You can skip this step with --skip-allure-combine. See the readme for more details.');
            }
        }

        // host the allure report as a localhost (useful if allure-combine doesn't work due to pip)
        if (fullConfig.hostAllure) {
            runShellCommand('allure open allure-report');
        }

        process.exit(exitCode);
    })();
}
