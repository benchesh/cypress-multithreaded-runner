// NOTE: Comments and general structure of this file are WIP

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const fs = require('fs-extra');

const { execSync, spawn } = require('child_process');

const kill = require('tree-kill');

const path = require('path');

const { argv } = yargs(hideBin(process.argv))
    .array(['onlyRunSpecFilesIncludingAnyText', 'onlyRunSpecFilesIncludingAllText', 'ignoreCliOverrides', 'specPhases'])
    .choices('logMode', [1, 2, 3, 4])
    .choices('threadMode', [1, 2])
    .number(['maxThreadRestarts', 'threadDelay', 'threadTimeout', 'maxCPUThreads',
        'waitForFileExist.minSize', 'waitForFileExist.timeout'
    ])
    .boolean(['openAllure', 'combineAllure', 'hostAllure',
        'waitForFileExist.deleteAfterCompletion', 'waitForFileExist.stopWaitingWhenFirstThreadCompletes'
    ])
    .alias('open', 'openAllure')
    .alias('combine', 'combineAllure')
    .alias('host', 'hostAllure')

/**
 * Recursively create a path if it doesn't exist
 * 
 * @param {string} str the path to check and create
 */
const mkdirSyncIfMissing = (s) => !fs.existsSync(s) && fs.mkdirSync(s, { recursive: true });

//for console logs
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const orange = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/**
 * Write to a file. Will create the file & destination folder if they don't exist
 * 
 * BASED ON https://gist.github.com/drodsou/de2ba6291aea67ffc5bc4b52d8c32abd?permalink_comment_id=4137595#gistcomment-4137595
 * 
 * @param {string} filepath the path of the file to write to
 * @param {string} content the contents to write to the file
 */
const writeFileSyncRecursive = (filepath, content = '') => {
    mkdirSyncIfMissing(path.dirname(filepath));
    fs.writeFileSync(filepath, content, { flag: 'w' });
};

const getDirectories = (srcpath) => (
    fs.existsSync(srcpath) ? fs.readdirSync(srcpath) : []
).map((file) => path.join(srcpath, file))
    .filter((filepath) => fs.statSync(filepath).isDirectory());

const getFiles = (srcpath) => (
    fs.existsSync(srcpath) ? fs.readdirSync(srcpath) : []
).map((file) => path.join(srcpath, file))
    .filter((filepath) => !fs.statSync(filepath).isDirectory());

const arrToNaturalStr = (arr) => {
    const str = arr.join(', ').replace(/,\s([^,]+)$/, ' and $1');

    if (str) {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    return str;
}

const strArrayTransformer = (data, lowercase = true) => {
    if (!data) return null;

    if (typeof data === 'string') {
        return [lowercase ? data.toLowerCase() : data]
    }

    data = data.filter(str => str);

    if (data.length) return data.map(str => str.toLowerCase())

    return null
}

const getFilesRecursive = (srcpath, arrayOfFiles = []) => {
    if (!fs.statSync(srcpath).isDirectory()) {
        return [srcpath];
    }

    fs.readdirSync(srcpath).forEach(function (file) {
        if (fs.statSync(path.join(srcpath, file)).isDirectory()) {
            arrayOfFiles = getFilesRecursive(path.join(srcpath, file), arrayOfFiles)
        } else {
            arrayOfFiles.push(path.join(srcpath, file))
        }
    })

    return arrayOfFiles;
}

let SuperTout = class {
    #_tout;
    #_callback;
    setTimeout = (callback, time) => {
        clearTimeout(this.#_tout);
        this.#_tout = setTimeout(callback, time);
        this.#_callback = callback;
    };
    clearTimeout = () => {
        clearTimeout(this.#_tout);

        if (this.#_callback) this.#_callback();
    };
};

module.exports = (config = {}) => {
    const fullConfig = { ...config, ...argv };

    (fullConfig.ignoreCliOverrides || []).forEach(prop => {
        fullConfig[prop] = config[prop];
    });

    const cypressConfigFilepath = fullConfig.cypressConfig?.filepath ? path.join(fullConfig.cypressConfig.filepath) : null;
    const cypressConfigObject = fullConfig.cypressConfig?.object;
    const reportDir = fullConfig.reportDir ? path.join(fullConfig.reportDir) : null;
    const specPhases = fullConfig.specPhases ? fullConfig.specPhases.map(specPhase => path.join(specPhase)) : null;
    const maxThreadRestarts = fullConfig.maxThreadRestarts ?? 5;
    const waitForFileExistTimeout = fullConfig.waitForFileExist?.timeout ?? 60;
    const waitForFileMinimumSize = fullConfig.waitForFileExist?.minSize ?? 2;
    const waitForFileExistFilepath = fullConfig.waitForFileExist?.filepath;
    const stopWaitingForFileWhenFirstThreadCompletes = fullConfig.waitForFileExist?.stopWaitingWhenFirstThreadCompletes ?? true;
    const threadTimeout = fullConfig.threadTimeout ?? 600;
    const threadDelay = (fullConfig.threadDelay ?? 30) * 1000;
    const logMode = fullConfig.logMode || 1;
    const allureReportHeading = fullConfig.allureReportHeading ? `: ${fullConfig.allureReportHeading}` : '';
    const threadMode = fullConfig.threadMode || 1;
    const threadOrder = fullConfig.threadOrder ?? 'benchmark';
    const saveThreadBenchmark = fullConfig.saveThreadBenchmark || true;
    const threadBenchmarkFilepath = fullConfig.threadBenchmarkFilepath || 'cmr-benchmarks.json';

    const reportHeadNotes = [];

    const maxCPUThreads = fullConfig.maxCPUThreads || Math.ceil(require('os').cpus().length / 2);
    let noOfThreadsInUse = 0;

    const onlyRunSpecFilesIncludingAnyText = strArrayTransformer(fullConfig.onlyRunSpecFilesIncludingAnyText);
    const onlyRunSpecFilesIncludingAllText = strArrayTransformer(fullConfig.onlyRunSpecFilesIncludingAllText);

    const additionalCypressEnvArgs = (() => {
        const grepTags = fullConfig.grepTags ? `grepTags="${fullConfig.grepTags}"` : null;
        const grep = fullConfig.grep ? `grep="${fullConfig.grep}"` : null;
        const grepUntagged = fullConfig.grepUntagged ? `grepUntagged="${fullConfig.grepUntagged}"` : null;
        const passthroughEnvArgs = fullConfig.passthroughEnvArgs || null;

        const arrStr = [grepTags, grep, grepUntagged, passthroughEnvArgs].filter(str => str).join(',');

        if (!arrStr) return '';

        return `,${arrStr}`
    })();

    const benchmarkObj = {
        cypressConfigFilepath,
        specPhases,
        threadMode,
        additionalCypressEnvArgs,
    };

    const benchmarkId = JSON.stringify(benchmarkObj);

    const openAllure = fullConfig.openAllure || fullConfig.open || false;
    const combineAllure = fullConfig.combineAllure || fullConfig.combine || false;
    const hostAllure = fullConfig.hostAllure || fullConfig.host || false;

    const defaultAllureReportDir = path.join(reportDir, 'allure-report');
    const allureReportDir = fullConfig.allureReportDir ? path.join(fullConfig.allureReportDir) : defaultAllureReportDir;

    const threadLogsDir = path.join(reportDir, 'cypress-logs');

    const runShellCommand = (cmd) => {
        execSync(cmd, {
            cwd: path.resolve(reportDir),
            stdio: [null, process.stdout, process.stderr]
        });
    };

    let thread2ExtraLog = '';

    let exitCode = 0;

    const wordpressConfigPhasesUnsorted = (() => {
        let phases = [];

        specPhases.forEach(dir => {
            if (threadMode === 1) {
                phases.push(getDirectories(dir));

                if (getFiles(dir).length) {
                    console.warn(orange(`WARNING: One or more files have been placed at the root of ${dir}. All spec files must be in subdirectories, otherwise they will not get tested when run with threadMode 1:\n${getFiles(dir).join('\n')}\n`));
                }
            } else {
                phases.push(getFilesRecursive(dir));
            }
        });

        // add a custom config to every thread to pass into the shell script
        return phases.map(phase => {
            return phase.length
                ? phase.map((dir) => {
                    return {
                        ...cypressConfigObject,
                        specPattern: onlyRunSpecFilesIncludingAnyText || onlyRunSpecFilesIncludingAllText
                            ? getFilesRecursive(dir).filter(file => {
                                const fileStr = fs.readFileSync(file).toString('utf8').toLowerCase();
                                return (onlyRunSpecFilesIncludingAnyText || ['']).some(text => fileStr.includes(text))
                                    && (onlyRunSpecFilesIncludingAllText || ['']).every(text => fileStr.includes(text))
                            })
                            : dir
                    }
                }).filter((thread) => thread.specPattern.length)
                : null
        }).filter((phase) => phase)
    })();

    if (!wordpressConfigPhasesUnsorted.length) {
        console.error(red('CRITICAL ERROR: No test phases were found!'));
        process.exit(1);
    }

    const wordpressConfigPhasesSorted = [];

    // raw test results are saved to this directory, which are then used to create the Allure report
    const allureResultsPath = path.join(reportDir, 'allure-results');

    const savedThreadBenchmark = fs.existsSync(threadBenchmarkFilepath) ? JSON.parse(fs.readFileSync(threadBenchmarkFilepath)) : {};

    if (threadOrder === 'benchmark' && savedThreadBenchmark[benchmarkId]) {
        wordpressConfigPhasesUnsorted.forEach((phase, phaseIndex) => {
            wordpressConfigPhasesSorted[phaseIndex] = [];

            phase.forEach(thread => {// bring any threads not present in the benchmark to the front
                if (!savedThreadBenchmark[benchmarkId].order.includes(String(thread.specPattern))) {
                    wordpressConfigPhasesSorted[phaseIndex].push(thread);
                }
            });

            savedThreadBenchmark[benchmarkId].order.forEach(threadPath => {
                wordpressConfigPhasesSorted[phaseIndex].push(
                    phase.find(thread => String(thread.specPattern) === threadPath)
                )
            });

            wordpressConfigPhasesSorted[phaseIndex] = wordpressConfigPhasesSorted[phaseIndex].filter((thread) => thread);
        });
    } else {
        wordpressConfigPhasesUnsorted.forEach((phase) => {
            wordpressConfigPhasesSorted.push(phase);
        });
    }

    const threadsMeta = {};

    wordpressConfigPhasesSorted.forEach((phase, phaseIndex) => {
        phase.forEach((thread, threadIndex) => {
            const threadNo = Number(Object.values(threadsMeta).length) + 1;

            threadsMeta[threadNo] = {
                cypressConfig: JSON.stringify(thread),
                path: String(thread.specPattern),
                phaseNo: Number(phaseIndex) + 1,
                threadNo: threadNo,
                status: 'success',
                retries: 0,
                perfResults: {},
                logs: '',
                printedLogs: false
            }
        });
    });

    if (onlyRunSpecFilesIncludingAnyText) {
        console.log(`NOTE: onlyRunSpecFilesIncludingAnyText is set to ["${onlyRunSpecFilesIncludingAnyText.join(', "')}"]. Therefore, only spec files that contain any strings from this array will be processed.\n`);

        reportHeadNotes.push(`onlyRunSpecFilesIncludingAnyText was set to ["${onlyRunSpecFilesIncludingAnyText.join(', "')}"]. Therefore, only spec files that contained any strings from this array were processed.\n`);
    }

    if (onlyRunSpecFilesIncludingAllText) {
        console.log(`NOTE: onlyRunSpecFilesIncludingAllText is set to ["${onlyRunSpecFilesIncludingAllText.join(', "')}"]. Therefore, only spec files that contain all strings from this array will be processed.\n`)

        reportHeadNotes.push(`onlyRunSpecFilesIncludingAllText was set to ["${onlyRunSpecFilesIncludingAllText.join(', "')}"]. Therefore, only spec files that contained all strings from this array were processed.\n`);
    }

    console.log(`${Object.values(threadsMeta).length} thread${Object.values(threadsMeta).length !== 1 ? 's' : ''} will be created to test spec files in the following order:\n${Object.values(threadsMeta).map(thread => thread.path).join('\n')}\nA maximum of ${Object.values(threadsMeta).length < maxCPUThreads ? Object.values(threadsMeta).length : maxCPUThreads} threads will be used at any one time\n`);

    if (!Object.values(threadsMeta).length) {
        console.error(red('CRITICAL ERROR: No spec files were found!'));
        process.exit(1);
    }

    // needed if a Cypress instance doesn't log anything but the shellscript still wants to write to the report directory
    mkdirSyncIfMissing(reportDir);

    const threadDelayTout = (new SuperTout);

    let logQueue = [];

    let phaseLock;

    (async () => {
        async function spawnThread(threadNo, logs = '', restartAttempts = 0, threadStarted = false) {
            const cypressProcess = spawn('bash', [
                path.resolve(__dirname, 'shell.sh'),
                // arguments for the shell script
                allureResultsPath || '',// $1
                cypressConfigFilepath || '',// $2
                threadsMeta[threadNo].cypressConfig,// $3
                threadNo,// $4
                additionalCypressEnvArgs,// $5
            ]);

            threadsMeta[threadNo].pid = cypressProcess.pid;

            if (phaseLock && phaseLock < threadsMeta[threadNo].phaseNo) {
                kill(cypressProcess.pid);
                return;
            }

            if (noOfThreadsInUse && logMode < 3) {
                if (logMode === 1) {
                    console.log(`Thread #${threadNo} is now starting, and its logs will be printed when all preceding threads have completed.`);
                } else if (logMode === 2) {
                    const fullQueue = [Object.values(threadsMeta).filter(thread => thread.printedLogs === 'some')].concat(logQueue);

                    console.log(`Thread #${threadNo} is now starting, and its logs will be printed once thread${fullQueue.length !== 1 ? 's' : ''}${fullQueue.map(thread => thread.threadNo)} have printed their logs.`);
                }
            } else {
                console.log(`Thread #${threadNo} is now starting...`);
            }

            threadsMeta[threadNo].perfResults.startTime = performance.now();

            noOfThreadsInUse++;

            let restartTests = false;

            const customWarning = (str) => {
                console.warn(orange(str));
                logs += `${str}\n`;
            }

            let inactivityTimer;

            const setInactivityTimer = () => {
                if (!threadTimeout) return;

                clearTimeout(inactivityTimer);
                inactivityTimer = setTimeout(() => {
                    customWarning(`The Cypress instance in thread #${threadNo} hasn\'t responded for ${threadTimeout} seconds and will be considered a crash.`);

                    restartTests = true;

                    kill(cypressProcess.pid);
                }, threadTimeout * 1000);
            };

            setInactivityTimer();

            // detect known internal errors and restart the tests when they occur!
            const logCheck = async (log) => {
                threadsMeta[threadNo].logs += log;

                if (logMode > 2) {
                    process.stdout.write(log);
                } else {
                    if (threadsMeta[threadNo].printedLogs) {
                        process.stdout.write(log);
                    } else if (!Object.values(threadsMeta).some(thread => thread.printedLogs === 'some' || thread.printedLogs === 'queue')) {
                        threadsMeta[threadNo].printedLogs = 'some';
                        process.stdout.write(log);
                    }
                }

                setInactivityTimer();

                logs += log;

                if (
                    log.includes('uncaught error was detected outside of a test')
                    || log.includes('we are skipping the remaining tests in the current suite')
                    || log.includes('Cypress could not associate this error to any specific test.')
                    || log.includes('Cypress: Fatal IO error')
                ) {
                    restartTests = true;

                    kill(cypressProcess.pid);
                } else if (log.includes('no spec files were found')) {
                    threadsMeta[threadNo].status = 'error';
                    threadsMeta[threadNo].errorType = 'no-spec-files';

                    kill(cypressProcess.pid);
                } else if (!threadStarted && log.includes('(Run Starting)')) {
                    threadStarted = true;
                    threadDelayTout.clearTimeout();
                }
            };

            cypressProcess.stdout.on('data', (data) => logCheck(data.toString()));
            cypressProcess.stderr.on('data', (data) => logCheck(data.toString()));

            const printAllLogs = () => {
                if (logMode > 2) {
                    return;
                }

                if (threadsMeta[threadNo].printedLogs) {
                    threadsMeta[threadNo].printedLogs = 'all';

                    logQueue = Object.values(threadsMeta).filter(thread => thread.printedLogs === 'queue');
                    const nextThreadToLog = Object.values(threadsMeta).find(thread => !thread.printedLogs);

                    for (let index = 0; index < logQueue.length; index++) {
                        if (logMode === 1 && logQueue[index].threadNo > nextThreadToLog?.threadNo) {//leave queued to maintain chronology
                            break;
                        } else {
                            threadsMeta[logQueue[index].threadNo].printedLogs = 'all';
                            process.stdout.write(logQueue[index].logs);
                        }
                    }

                    if (nextThreadToLog) {
                        threadsMeta[nextThreadToLog.threadNo].printedLogs = 'some';
                        process.stdout.write(nextThreadToLog.logs);
                    }
                } else {
                    threadsMeta[threadNo].printedLogs = 'queue';
                }
            }

            logCheck(`Start of thread #${threadNo}:\n`);

            const threadCompleteFunc = () => {
                printAllLogs();

                if (!threadsMeta[threadNo].logs.includes('All specs passed')) {
                    phaseLock = threadsMeta[threadNo].phaseNo;

                    const threadsFromPhasesAfterCurrent = Object.values(threadsMeta).filter(thread => thread.phaseNo > phaseLock);

                    if (threadsFromPhasesAfterCurrent.length) {
                        customWarning(orange(`Thread #${threadNo} failed, and as it's from phase #${phaseLock}, all threads from following phases will be stopped immediately.`))

                        threadsFromPhasesAfterCurrent.forEach(thread => {
                            if (thread.pid) kill(thread.pid);
                        });
                    }
                }

                writeFileSyncRecursive(path.join(threadLogsDir, `thread_${threadNo}.txt`), logs);

                // the thread might not have been marked as started if it never started properly!
                if (!threadStarted) {
                    threadStarted = true;
                    threadDelayTout.clearTimeout();
                }

                noOfThreadsInUse--;
                threadsMeta[threadNo].complete = true;
                threadsMeta[threadNo].pid = false;
                threadsMeta[threadNo].perfResults.secs = parseInt(
                    (performance.now() - threadsMeta[threadNo].perfResults.startTime) / 1000
                );
            }

            return new Promise((resolve) => {
                cypressProcess.on('close', async () => {
                    clearTimeout(inactivityTimer);

                    if (restartTests) {
                        restartAttempts++;
                        threadsMeta[threadNo].retries++;

                        if (restartAttempts < maxThreadRestarts) {
                            threadsMeta[threadNo].status = 'warn';

                            customWarning(`WARNING: Internal Cypress error in thread #${threadNo}! Will retry a maximum of ${maxThreadRestarts - restartAttempts} more time${(maxThreadRestarts - restartAttempts) !== 1 ? 's' : ''}.`);

                            // delete any test results as they'll interfere with the next run
                            if (fs.pathExistsSync(path.join(allureResultsPath, String(threadNo)))) {
                                fs.rmSync(path.join(allureResultsPath, String(threadNo)), { recursive: true, force: true });
                            }

                            await spawnThread(threadNo, logs, restartAttempts, threadStarted);
                        } else {
                            threadsMeta[threadNo].status = 'error';
                            threadsMeta[threadNo].errorType = 'critical';
                            exitCode = 1;

                            customWarning(`CRITICAL ERROR: Too many internal Cypress errors in thread #${threadNo}. Giving up after ${maxThreadRestarts} attempts!`);
                            threadCompleteFunc();
                        }

                        resolve();
                    } else {
                        threadCompleteFunc();

                        resolve();
                    }
                });
            });
        }

        const waitForFileExist = () => {
            let waitForFileExistRemainingTime = waitForFileExistTimeout;

            return new Promise(resolve => {
                const interv = setInterval(() => {
                    if (
                        fs.existsSync(waitForFileExistFilepath)
                        && Buffer.byteLength(fs.readFileSync(waitForFileExistFilepath)) >= waitForFileMinimumSize
                    ) {// the file exists and has an acceptable filesize
                        clearInterval(interv);
                        resolve();
                    } else if (
                        stopWaitingForFileWhenFirstThreadCompletes
                        && Object.values(threadsMeta).find(thread => thread.complete)
                    ) {
                        //TODO not the best solution, too bad!
                        thread2ExtraLog = `WARNING: There may be an issue as the first thread has completed but the "${waitForFileExistFilepath}" file doesn't exist... will continue anyway!`;
                        console.warn(orange(thread2ExtraLog));

                        clearInterval(interv);
                        resolve();
                    } else {
                        waitForFileExistRemainingTime -= 0.5;

                        if (waitForFileExistRemainingTime <= 0) {
                            //TODO not the best solution, too bad!
                            thread2ExtraLog = `WARNING: There may be an issue as the "${waitForFileExistFilepath}" file doesn't exist after ${waitForFileExistTimeout} seconds... will continue anyway!`;
                            console.warn(orange(thread2ExtraLog));

                            clearInterval(interv);
                            resolve();
                        }
                    }
                }, 500);
            });
        }

        // the maximum delay before starting the next thread
        // the delay will be interrupted as soon as the current Cypress has started running
        const delay = (ms) => {
            return new Promise(resolve => threadDelayTout.setTimeout(() => {
                if (noOfThreadsInUse < maxCPUThreads) {
                    resolve();
                }
            }, ms));
        }

        async function runCypressTests() {
            let threadsArr = []
            threadsArr.push(spawnThread(1));

            if (Object.values(threadsMeta).length > 1) {
                if (waitForFileExistFilepath) {
                    // decrease total delay by .5s as waitForFileExist will check for the file in intervals of .5s
                    await delay(threadDelay - 500 > 0 ? threadDelay - 500 : 0);

                    await waitForFileExist();
                } else {
                    await delay(threadDelay);
                }

                threadsArr.push(spawnThread(2));

                for (const [index] of Object.values(threadsMeta).slice(2).entries()) {
                    await delay(threadDelay);
                    threadsArr.push(spawnThread(Number(index) + 3));
                }
            }

            await Promise.all(threadsArr)
        }

        await runCypressTests();

        if (logMode === 4) {
            Object.values(threadsMeta).forEach(thread => {
                process.stdout.write(thread.logs);
            })
        }

        console.log('All Cypress testing threads have ended.');

        let reportText = '';

        // bulk of multithread report logic
        {
            const secondsToNaturalString = (seconds) => {
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds - (minutes * 60);

                return `${minutes ? `${minutes} minutes, ` : ''}${remainingSeconds} seconds`;
            };

            let longestThread = { secs: -1 };

            Object.values(threadsMeta).forEach((thread) => {
                const failedTests = {};
                let mostFailsForOneTest = 0;

                // record how many tests failed, and how many times!
                getFiles(
                    path.join(allureResultsPath, String(thread.threadNo)),
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

                            if (failedTests[key] > mostFailsForOneTest) {
                                mostFailsForOneTest = failedTests[key];
                            }
                        }
                    }

                    // files from all threads need to be in the same directory to construct the Allure report
                    fs.moveSync(
                        file,
                        path.resolve(allureResultsPath, path.basename(file)),
                        { overwrite: true },
                    );
                });

                threadsMeta[thread.threadNo].perfResults = {
                    ...thread.perfResults,
                    failedTests,
                    naturalString: secondsToNaturalString(thread.perfResults.secs),
                    mostFailsForOneTest
                };

                // the longest thread is used as the basis of comparison with the others
                if (thread.perfResults.secs > longestThread.secs) {
                    longestThread = {
                        threadNo: thread.threadNo,
                        naturalString: secondsToNaturalString(thread.perfResults.secs),
                        secs: thread.perfResults.secs
                    };
                }
            });

            if (saveThreadBenchmark) {
                benchmarkObj.order = Object.values(threadsMeta).sort((a, b) => b.perfResults.secs - a.perfResults.secs).map(threadsMeta => threadsMeta.path);

                fs.writeFileSync(threadBenchmarkFilepath, JSON.stringify({
                    ...savedThreadBenchmark,
                    [benchmarkId]: benchmarkObj,
                }, null, 4));
            }

            // a visual representation of how each thread performed, to show where any bottlenecks lie
            const generateThreadBars = (timeOfLongestThread) => {
                let str = '';

                Object.values(threadsMeta).forEach((thread) => {
                    const threadPath = thread.path;

                    const threadId = Object.values(threadsMeta).length > 9 ? String(thread.threadNo).padStart(2, '0') : thread.threadNo;

                    const shortThreadPath = threadPath.length > 60
                        ? `...${threadPath.substring(threadPath.length - 57).match(/\/(.*)$/)?.[0] || threadPath.substring(threadPath.length - 57)}`
                        : threadPath;

                    threadsMeta[thread.threadNo].heading = [`Thread #${threadId} [${shortThreadPath}]`];

                    str += `Thread #${threadId} [${threadPath}]\n`;

                    if (threadsMeta[thread.threadNo].errorType === 'no-spec-files') {
                        const err = 'ERROR: No spec files found!';
                        threadsMeta[thread.threadNo].heading.push(err);
                        threadsMeta[thread.threadNo].summary = `ERROR: No spec files were found for thread #${thread.threadNo}`;
                        str += `${err}\n\n`;
                        exitCode = 1;
                    } else if (threadsMeta[thread.threadNo].errorType === 'critical') {
                        const err = 'CRITICAL ERROR: Thread did not complete!';
                        threadsMeta[thread.threadNo].status = 'error';
                        threadsMeta[thread.threadNo].errorType = 'critical';
                        threadsMeta[thread.threadNo].heading.push(err);
                        str += `${err}\n\n`;
                        exitCode = 1;
                    }

                    const percentageOfTotal = (
                        threadsMeta[thread.threadNo].perfResults.secs / timeOfLongestThread
                    ) * 100;

                    const percentageBar = `${Array.from({ length: Math.round(percentageOfTotal / 2) }, () => '█').concat(
                        Array.from({ length: 50 - Math.round(percentageOfTotal / 2) }, () => '░'),
                    ).join('')}`;

                    // log if any tests in the thread failed/retried
                    const reportFailedTests = (obj) => {
                        const result = [];

                        if (Object.entries(obj).length) {
                            threadsMeta[thread.threadNo].status = 'warn';

                            const counts = Object.values(obj).reduce((acc, curr) => {
                                acc[curr] = (acc[curr] || 0) + 1;
                                return acc;
                            }, {});

                            Object.keys(counts).sort((a, b) => b - a).forEach((num) => {
                                result.push(`${counts[num]} test${counts[num] > 1 ? 's' : ''} failed ${num} time${num > 1 ? 's' : ''}`);
                            });
                        }

                        if (threadsMeta[thread.threadNo].retries) {
                            threadsMeta[thread.threadNo].status = 'warn';
                            result.push(`the thread needed restarting ${threadsMeta[thread.threadNo].retries} time${threadsMeta[thread.threadNo].retries === 1 ? '' : 's'}`);
                        }

                        if (!result.length) {
                            return '';
                        }

                        threadsMeta[thread.threadNo].heading.push(`WARNING: ${arrToNaturalStr(result)}`);
                        threadsMeta[thread.threadNo].summary = `WARNING: Thread #${thread.threadNo}: ${arrToNaturalStr(result)}`;

                        return ` (WARNING: ${arrToNaturalStr(result)})`;
                    };

                    str += `${percentageBar} ${percentageOfTotal.toFixed(2)}% (${threadsMeta[thread.threadNo].perfResults.naturalString})${reportFailedTests(threadsMeta[thread.threadNo].perfResults.failedTests)}\n\n`;
                });

                return str;
            };

            reportText = `See below to compare how each thread is performing.\n\n${generateThreadBars(longestThread.secs)}The percentages given above represent how much time individual threads take relative to thread #${longestThread.threadNo}, which took the longest to complete at ${longestThread.naturalString}. Any thread that takes significantly longer than others will be a bottleneck, so the closer the percentages are to one another, the better. A wide range in percentages indicates that the threads could be balanced more efficiently. Any failing tests will retry up to two more times, so in those instances the affected threads will take much longer to complete than if all tests passed on the first attempt.`;

            console.log(`\n\n${reportText}\n\n`);

            // save these logs for future reference!
            fs.writeFileSync(path.resolve(reportDir, 'thread-performance-report.txt'), reportText);
        }

        // Overwrite the historyIds in the Allure results, as the Allure plugin's method is flawed.
        // Doing this ensures tests across identical names are included in the report
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

        // generate the Allure report from the most recent run
        runShellCommand('allure generate allure-results --clean -o allure-report');

        // make sure none of the tests failed!
        {
            const testResultsObj = fs.readJsonSync(
                path.resolve(reportDir, 'allure-report', 'history', 'history-trend.json'),
                'utf-8',
            )[0].data;

            if (
                testResultsObj.failed
                + testResultsObj.broken
                + testResultsObj.unknown !== 0
            ) {
                let mostFailsForOneTestAcrossAllThreads = 1;

                Object.entries(threadsMeta).forEach((thread) => {// determine how many times a test is allowed to fail until it gives up
                    if (thread[1].perfResults.mostFailsForOneTest > mostFailsForOneTestAcrossAllThreads) {
                        mostFailsForOneTestAcrossAllThreads = thread[1].perfResults.mostFailsForOneTest;
                    }
                });

                Object.keys(threadsMeta).forEach((threadNo) => {
                    if (threadsMeta[threadNo].perfResults.mostFailsForOneTest === mostFailsForOneTestAcrossAllThreads) {
                        threadsMeta[threadNo].status = 'error';
                    }
                });

                exitCode = 1;
            }
        }

        const defaultAllureReportHtml = path.resolve(defaultAllureReportDir, 'index.html');
        const defaultAllureReportHtmlComplete = path.resolve(defaultAllureReportDir, 'complete.html');

        const allureReportHtml = path.resolve(allureReportDir, 'index.html');
        const allureReportHtmlComplete = path.resolve(allureReportDir, 'complete.html');

        if (fs.existsSync(defaultAllureReportHtml)) {
            let allLogs = '';

            getFiles(
                threadLogsDir
            ).forEach((file) => {
                const threadNo = file.split('_')[1].split('.txt')[0];

                threadsMeta[threadNo].logs = `<div class="cmr-thread cmr-${threadsMeta[threadNo].status}"><span class="cmr-pre-heading"><h2 id="cmr-arr-${threadNo}">➡️</h2><h2>${threadsMeta[threadNo].heading.join('<br>')}</h2></span><pre id="cmr-pre-${threadNo}" style="display:none">${threadNo === '2' && thread2ExtraLog ? `${thread2ExtraLog}\n` : ''}${fs.readFileSync(file).toString('utf8')}</pre></div>`;
            });

            Object.values(threadsMeta).forEach(thread => {
                if (thread.logs) {
                    allLogs += thread.logs;
                }
            })

            const criticalErrorThreads = Object.entries(threadsMeta).filter(o => o[1].errorType === 'critical').map(o => o[0]);
            const minorErrorThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'error').filter(o => o[1].errorType !== 'critical').map(o => o[0]);
            const allErrorThreads = criticalErrorThreads.concat(minorErrorThreads);
            const warnThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'warn').map(o => o[0]);

            const cmrAllureBody = `<body>
            <div class="cmr-content">
                ${criticalErrorThreads.length ? `
                <div class="cmr-error">
                    <h2>Cypress Multithreaded Runner${allureReportHeading} [CRITICAL ERRORS - PLEASE READ]</h2>
                    Be advised! This Allure report doesn't tell the full story, as <strong>thread ${arrToNaturalStr(criticalErrorThreads.map(num => `#${num}`))} had ${criticalErrorThreads.length > 1 ? 'critical errors' : 'a critical error'}</strong> and didn't complete! Therefore, one or more spec files may have not been fully tested! Scroll down to read the full logs from the separate threads.
                </div>` : ''}
                ${minorErrorThreads.length ? `
                <div class="cmr-error">
                    ${criticalErrorThreads.length ? '' : `<h2>Cypress Multithreaded Runner${allureReportHeading}</h2>`}
                    ${minorErrorThreads.map(threadNo => threadsMeta[threadNo].summary).join('<br>')}${criticalErrorThreads.length ? '' : '<br>Scroll down to read the full logs from the separate threads.'}
                </div>` : ''}
                ${warnThreads.length ? `
                <div class="cmr-warn">
                    ${allErrorThreads.length ? '' : `<h2>Cypress Multithreaded Runner${allureReportHeading}</h2>`}
                    ${warnThreads.map(threadNo => threadsMeta[threadNo].summary).join('<br>')}${allErrorThreads.length ? '' : '<br>Scroll down to read the full logs from the separate threads.'}
                </div>` : ''}
                ${!allErrorThreads.length && !warnThreads.length ? `
                <div class="cmr-success">
                    <h2>Cypress Multithreaded Runner${allureReportHeading}</h2>
                    Everything seems completely fine! No tests needed retrying. Scroll down to read the full logs from the separate threads.
                </div>
                `: ''}
                ${reportHeadNotes.length ? `
                <div class="cmr-notes">
                    ${reportHeadNotes.map(note => `NOTE: ${note}`).join('<br>')}
                </div>` : ''}
            </div>`;

            const cmrAllureFooter = `<div class="cmr-content cmr-footer">${allLogs
                .replace(/Couldn't find tsconfig.json. tsconfig-paths will be skipped\n/g, '')// this warning is noisy, remove it
                .replace(/tput: No value for \$TERM and no -T specified\n/g, '')// this warning is noisy, remove it
                }<div class="cmr-report"><button id="cmr-open-all">Open all logs above</button><button id="cmr-close-all">Close all logs above</button><br><br><h2>Thread Performance Summary</h2><pre>${reportText}</pre></div></div>
            
                <style>
                .cmr-content #cmr-close-all {
                    margin-left: 20px;
                }
                .cmr-footer h2 {
                  margin-bottom: 0;
                }
            
                .cmr-content h2 {
                  margin-top: 0;
                }
            
                .cmr-content div:nth-child(even) {
                  filter: brightness(0.92);
                }
            
                .cmr-content pre {
                  overflow-wrap: break-word;
                }
            
                .cmr-content div {
                  padding: 20px;
                  background: white;
                  min-width: 890px;
                  display: block;
                }
            
                .cmr-content div.cmr-error {
                  background: #fd5a3e;
                }
            
                .cmr-content div.cmr-warn {
                  background: #ffbe11;
                }
            
                .cmr-content div.cmr-success {
                  background: #97cc64;
                }

                .cmr-content div.cmr-notes {
                  background: #aaa;
                }
            
                .cmr-content .cmr-pre-heading {
                  cursor: pointer;
                  display: flex;
                  gap: 10px;
                  position: sticky;
                  top: 0;
                  background: inherit;
                }
              </style>
              <script>
                [...document.querySelectorAll('.cmr-pre-heading')].forEach((heading, index) => {
                  const thisIndex = index + 1;
            
                  heading.addEventListener('click', () => {
                    heading.classList.toggle('cmr-pre-heading-active');

                    const thisPre = document.querySelector('#cmr-pre-' + thisIndex);
                    const thisArr = document.querySelector('#cmr-arr-' + thisIndex);
            
                    if (thisPre.style.display === 'none') {
                      thisPre.style.removeProperty('display');
                      thisArr.innerHTML = '⬇️';
                    } else {
                      thisPre.style.display = 'none';
                      thisArr.innerHTML = '➡️';
                    }
                  });
                });

                document.querySelector('#cmr-open-all').addEventListener('click', () => {
                    [...document.querySelectorAll('.cmr-pre-heading:not(.cmr-pre-heading-active)')].forEach((heading)=>{heading.click()});
                    window.scrollTo(0,999999999);
                });

                document.querySelector('#cmr-close-all').addEventListener('click', () => {
                    [...document.querySelectorAll('.cmr-pre-heading-active')].forEach((heading)=>{heading.click()});
                    window.scrollTo(0,999999999);
                });
                </script>
            </body>`;

            fs.writeFileSync(
                defaultAllureReportHtml,
                fs.readFileSync(defaultAllureReportHtml)
                    .toString('utf8')
                    .replace(/.*(googletagmanager|gtag|dataLayer|<script>|\n<\/script>).*/gm, '')// hack to remove some dodgy html that breaks allure-combine
            )

            let combinedAllureSuccessfully = false;

            if (combineAllure) {
                try {
                    runShellCommand('pip install allure-combine && allure-combine allure-report');

                    fs.writeFileSync(
                        defaultAllureReportHtmlComplete,
                        fs.readFileSync(defaultAllureReportHtmlComplete)
                            .toString('utf8')
                            .replace('<body>', cmrAllureBody)
                            .replace('</body>', cmrAllureFooter)
                    );

                    console.log(green(`The Allure report for this run has been bundled into a single HTML file: "${allureReportHtmlComplete}"`));

                    combinedAllureSuccessfully = true;
                } catch (err) {
                    console.log(red('Error when attempting to bundle the Allure report into a single file! You might not have pip installed. See the readme for more details.'));
                }
            }

            // we add our custom elements into the HTML AFTER allure-combine because allure-combine will crash otherwise!
            fs.writeFileSync(
                defaultAllureReportHtml,
                fs.readFileSync(defaultAllureReportHtml)
                    .toString('utf8')
                    .replace('<body>', cmrAllureBody)
                    .replace('</body>', cmrAllureFooter)
            );

            if (allureReportDir !== defaultAllureReportDir) {
                fs.moveSync(
                    defaultAllureReportDir,
                    allureReportDir,
                    { overwrite: true },
                );
            }

            // host the Allure report as a localhost
            if (hostAllure) {
                runShellCommand(`allure open "${allureReportDir}"`);
            } else if (openAllure) {
                if (combinedAllureSuccessfully) {
                    runShellCommand(`open "${allureReportHtmlComplete}"`);
                } else {
                    runShellCommand(`open "${allureReportHtml}"`);
                }
            }

            console.log(green(`The Allure report for this run has been saved to the following directory: "${allureReportDir}"`));
        }

        if (fullConfig.waitForFileExist?.deleteAfterCompletion) {
            if (fs.existsSync(waitForFileExistFilepath)) {
                fs.unlinkSync(waitForFileExistFilepath);
            }
        }

        process.exit(exitCode);
    })();
}
