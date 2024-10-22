// NOTE: Comments and general structure of this file are WIP

const { importAll } = require('./lib/importAll.js');
importAll().from('./common.js');

const fs = require('fs-extra');

const { execSync, spawn } = require('child_process');

const killSync = require('kill-sync');
const kill = (pid) => killSync(pid, 'SIGINT', true);

const path = require('path');

const noConsoleColours = String(process.env.NO_COLOR) === '1';

/**
 * Recursively create a path if it doesn't exist
 * 
 * @param {string} str the path to check and create
 */
const mkdirSyncIfMissing = (s) => !fs.existsSync(s) && fs.mkdirSync(s, { recursive: true });

//for console logs
const green = (s) => noConsoleColours ? s : `\x1b[32m${s}\x1b[0m`;
const orange = (s) => noConsoleColours ? s : `\x1b[33m${s}\x1b[0m`;
const red = (s) => noConsoleColours ? s : `\x1b[31m${s}\x1b[0m`;

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
    arr = arr.filter(a => a);

    if (!arr.length) {
        return '';
    }

    let str;

    if (arr.length === 1) {
        str = arr[0];
    } else {
        str = [arr.slice(0, -1).join(', ')].concat([arr[arr.length - 1]]).join(' and ');
    }

    return str.charAt(0).toUpperCase() + str.slice(1);
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

// Remove falsy values from an object
const filterObj = (obj) => {
    return Object.keys(obj).reduce((acc, key) => {
        if (obj[key]) {
            acc[key] = obj[key]
        }

        return acc
    }, {})
}

module.exports = async (config = {}) => {
    const startTime = performance.now();

    const fullConfig = getFullConfig(config);

    const reportDir = fullConfig.reportDir ? path.join(fullConfig.reportDir) : null;
    const maxThreadRestarts = fullConfig.maxThreadRestarts ?? 5;
    const waitForFileExistTimeout = fullConfig.waitForFileExist?.timeout ?? 60;
    const waitForFileMinimumSize = fullConfig.waitForFileExist?.minSize ?? 2;
    const waitForFileExistFilepath = fullConfig.waitForFileExist?.filepath;
    const stopWaitingForFileWhenFirstThreadCompletes = fullConfig.waitForFileExist?.stopWaitingWhenFirstThreadCompletes ?? true;

    const threadInactivityTimeout = fullConfig.threadInactivityTimeout ?? 60 * 10;
    const threadTimeLimit = fullConfig.threadTimeLimit ?? 60 * 30;

    const threadDelay = (fullConfig.threadDelay ?? 30) * 1000;
    const logMode = fullConfig.logMode || 1;
    const allureReportHeading = fullConfig.allureReportHeading ? `: ${fullConfig.allureReportHeading}` : '';
    const threadMode = fullConfig.threadMode || 1;
    const orderThreadsByBenchmark = fullConfig.orderThreadsByBenchmark ?? true;
    const saveThreadBenchmark = fullConfig.saveThreadBenchmark ?? true;
    const threadBenchmarkFilepath = fullConfig.threadBenchmarkFilepath || 'cmr-benchmarks.json';
    const benchmarkDescription = fullConfig.benchmarkDescription ?? null;
    const specFiles = fullConfig.specFiles ?? null;

    const generateAllure = fullConfig.generateAllure ?? true;

    const endProcessIfTestsFail = fullConfig.endProcessIfTestsFail ?? true;

    const repeat = fullConfig.repeat || 1;

    const reportHeadNotes = [];

    const maxConcurrentThreads = fullConfig.maxConcurrentThreads || Math.ceil(require('os').cpus().length / 2);
    let noOfThreadsInUse = 0;

    const onlyPhaseNo = fullConfig.onlyPhaseNo;
    const startingPhaseNo = fullConfig.startingPhaseNo;
    const endingPhaseNo = fullConfig.endingPhaseNo;

    const userSkippingPhase = (phaseNo) => {
        return onlyPhaseNo && onlyPhaseNo !== phaseNo
            || startingPhaseNo > phaseNo
            || endingPhaseNo < phaseNo
    }

    const phases = fullConfig.phases.map(phase => {
        return {
            ...fullConfig.phaseDefaults,
            ...phase,
        }
    }).map(phase => {
        return {
            ...phase,
            specsDir: phase.specsDir ? path.join(phase.specsDir) : null,
            cypressConfigFilepath: phase.cypressConfig?.filepath ? path.join(phase.cypressConfig.filepath) : null,
            cypressConfigObject: phase.cypressConfig?.object,
            onlyRunSpecFilesIncludingAnyText: strArrayTransformer(phase.onlyRunSpecFilesIncludingAnyText),
            onlyRunSpecFilesIncludingAllText: strArrayTransformer(phase.onlyRunSpecFilesIncludingAllText),
            additionalCypressEnvArgs: (() => {
                const grepTags = phase.grepTags ? `grepTags="${phase.grepTags}"` : null;
                const grep = phase.grep ? `grep="${phase.grep}"` : null;
                const grepUntagged = phase.grepUntagged ? `grepUntagged="${phase.grepUntagged}"` : null;
                const passthroughEnvArgs = phase.passthroughEnvArgs || null;

                const arrStr = [grepTags, grep, grepUntagged, passthroughEnvArgs].filter(str => str).join(',');

                if (!arrStr) return '';

                return `,${arrStr}`
            })(),
        }
    });

    const benchmarkObj = filterObj({
        benchmarkDescription,
        threadMode,
        specFiles,
        onlyPhaseNo,
        startingPhaseNo,
        endingPhaseNo,
        phases: phases.map(phase => {
            return filterObj({
                cypressConfigFilepath: phase.cypressConfigFilepath,
                specsDir: phase.specsDir,
                onlyRunSpecFilesIncludingAnyText: phase.onlyRunSpecFilesIncludingAnyText,
                onlyRunSpecFilesIncludingAllText: phase.onlyRunSpecFilesIncludingAllText,
                additionalCypressEnvArgs: phase.additionalCypressEnvArgs,
            })
        }),
    });

    const benchmarkId = btoa(JSON.stringify(benchmarkObj));

    const openAllure = fullConfig.openAllure || false;
    const combineAllure = fullConfig.combineAllure || false;
    const hostAllure = fullConfig.hostAllure || false;

    const defaultAllureReportDir = path.join(reportDir, 'allure-report');
    const allureReportDir = fullConfig.allureReportDir ? path.join(fullConfig.allureReportDir) : defaultAllureReportDir;
    const jUnitReportDir = path.join(reportDir, 'junit');

    const threadLogsDir = path.join(reportDir, 'cypress-logs');

    const runShellCommand = (cmd, cwd = path.resolve(reportDir)) => {
        execSync(cmd, {
            cwd,
            stdio: [null, process.stdout, process.stderr]
        });
    };

    let thread2ExtraLog = '';

    let exitCode = 0;

    if (fullConfig.maxConcurrentThreadsExperiment) {
        console.warn(orange('WARNING: maxConcurrentThreadsExperiment will not work when run through the async mode'));
    }

    const cypressConfigPhasesUnsorted = phases.map(phase => {
        const specs = (() => {
            if (threadMode === 2 && !specFiles) {
                const arr = getDirectories(phase.specsDir);

                if (getFiles(phase.specsDir).length) {
                    console.warn(orange(`WARNING: One or more files have been placed at the root of ${phase.specsDir}. All spec files must be in subdirectories, otherwise they will not get tested when run with threadMode 2:\n${getFiles(phase.specsDir).join('\n')}\n`));
                }

                return arr;
            } else {
                return getFilesRecursive(phase.specsDir);
            }
        })();

        return specs.map((spec) => {
            return {
                ...phase.cypressConfigObject, // add a custom config to every thread to pass into the shell script
                specPattern: (() => {
                    const specsList = phase.onlyRunSpecFilesIncludingAnyText || phase.onlyRunSpecFilesIncludingAllText
                        ? getFilesRecursive(spec).filter(file => {
                            const fileStr = fs.readFileSync(file).toString('utf8').toLowerCase();
                            return (phase.onlyRunSpecFilesIncludingAnyText || ['']).some(text => fileStr.includes(text))
                                && (phase.onlyRunSpecFilesIncludingAllText || ['']).every(text => fileStr.includes(text))
                        })
                        : [spec];

                    if (specFiles) {
                        return specsList.filter(spec => specFiles.some(
                            specFile => (spec.endsWith(specFile) && path.basename(specFile) === path.basename(spec))
                                || (path.resolve(specFile) === path.resolve(spec))
                        ));
                    }

                    return specsList;
                })()
            }
        }).filter((thread) => thread.specPattern.length)
    }).filter((phase) => phase)

    if (!cypressConfigPhasesUnsorted.length) {
        console.error(red('CRITICAL ERROR: No test phases were found!'));
        process.exit(1);
    }

    const cypressConfigPhasesSorted = [];

    // raw test results are saved to this directory, which are then used to create the Allure report
    const allureResultsPath = path.resolve(path.join(reportDir, 'allure-results'));

    const savedThreadBenchmark = fs.existsSync(threadBenchmarkFilepath) ? (() => {
        try {
            return JSON.parse(fs.readFileSync(threadBenchmarkFilepath));
        } catch (err) {
            return {};
        }
    })() : {};

    if (orderThreadsByBenchmark && savedThreadBenchmark[benchmarkId]) {
        cypressConfigPhasesUnsorted.forEach((phase, phaseIndex) => {
            cypressConfigPhasesSorted[phaseIndex] = [];

            const benchmarkOrder = [...new Set(savedThreadBenchmark[benchmarkId].order)];

            phase.forEach(thread => {// bring any threads not present in the benchmark to the front
                if (!benchmarkOrder.includes(String(thread.specPattern))) {
                    cypressConfigPhasesSorted[phaseIndex].push(thread);
                }
            });

            benchmarkOrder.forEach(threadPath => {
                cypressConfigPhasesSorted[phaseIndex].push(
                    phase.find(thread => String(thread.specPattern) === threadPath)
                )
            });

            cypressConfigPhasesSorted[phaseIndex] = cypressConfigPhasesSorted[phaseIndex].filter((thread) => thread);
        });
    } else {
        cypressConfigPhasesUnsorted.forEach((phase) => {
            cypressConfigPhasesSorted.push(phase);
        });
    }

    const threadsMeta = {};

    const initLogs = [];

    cypressConfigPhasesSorted.forEach((phase, phaseIndex) => {
        const phaseNo = Number(phaseIndex) + 1;
        initLogs.push(`[PHASE ${phaseNo}]`)

        if (!phase.length) {
            initLogs[initLogs.length - 1] += ' (No spec files found, skipping)';
            return;
        }

        if (userSkippingPhase(phaseNo)) {
            initLogs[initLogs.length - 1] += ' (Skipping phase)';
            return;
        }

        for (let i = 0; i < repeat; i++) {
            phase.forEach((thread) => {
                const threadNo = Number(Object.values(threadsMeta).length) + 1;
                const threadPath = String(thread.specPattern);

                threadsMeta[threadNo] = {
                    cypressConfigFilepath: phases[phaseIndex].cypressConfigFilepath,
                    cypressConfig: JSON.stringify(thread),
                    browser: phases[phaseIndex].browser,
                    path: threadPath,
                    phaseNo,
                    threadNo,
                    status: 'success',
                    retries: 0,
                    perfResults: {},
                    logs: '',
                    printedLogs: false,
                    additionalCypressEnvArgs: phases[phaseIndex].additionalCypressEnvArgs,
                    mochaFile: fullConfig.jUnitReport?.enabled ? path.join(jUnitReportDir, `${String(threadNo)}.xml`) : null,
                    killFunc: () => { threadsMeta[threadNo].skip = true }
                }

                initLogs[initLogs.length - 1] += `\nThread ${threadNo}: "${threadPath}"${!savedThreadBenchmark[benchmarkId]?.order.includes(threadPath) ? ' (not found in benchmark)' : ''}`;
            });
        }

        if (phases[phaseIndex].onlyRunSpecFilesIncludingAnyText) {
            const note = `For phase #${phaseNo}, onlyRunSpecFilesIncludingAnyText is set to ["${phases[phaseIndex].onlyRunSpecFilesIncludingAnyText.join('", "')}"]. Therefore, only spec files that contain any strings from this array will be processed.`;

            initLogs.push(note);
            reportHeadNotes.push(note);
        }

        if (phases[phaseIndex].onlyRunSpecFilesIncludingAllText) {
            const note = `For phase #${phaseNo}, onlyRunSpecFilesIncludingAllText is set to ["${phases[phaseIndex].onlyRunSpecFilesIncludingAllText.join('", "')}"]. Therefore, only spec files that contain all strings from this array will be processed.`;

            initLogs.push(note);
            reportHeadNotes.push(note);
        }
    });

    initLogs.unshift(`${Object.values(threadsMeta).length} thread${Object.values(threadsMeta).length !== 1 ? 's' : ''} will be created to test the following spec files in the following order:`)

    if (cypressConfigPhasesSorted.length > 1) {
        initLogs.push('Should tests in any phase fail, all threads from subsequent phases will stop immediately.');
    }

    initLogs.push(`A maximum of ${Object.values(threadsMeta).length < maxConcurrentThreads ? Object.values(threadsMeta).length : maxConcurrentThreads} threads will be used at any one time.\nThis code is executing on a machine with ${require('os').cpus().length} logical CPU threads.`);

    if (repeat > 1) {
        initLogs.push(green(`Repeat is set to ${repeat}. Therefore, all threads in all phases will run ${repeat} times, regardless of whether the tests pass or fail.`));
    }

    if (!saveThreadBenchmark) {
        initLogs.push(orange('saveThreadBenchmark is set to false, therefore the benchmark file will not be updated when this run completes.'));
    }

    console.log(`${initLogs.join('\n\n')}\n`)

    if (!Object.values(threadsMeta).length) {
        console.error(red('CRITICAL ERROR: No spec files were found!'));
        process.exit(1);
    }

    // needed if a Cypress instance doesn't log anything but the shellscript still wants to write to the report directory
    mkdirSyncIfMissing(reportDir);

    const threadDelayTout = (new SuperTout);

    let logQueue = [];

    let phaseLock;

    async function spawnThread(threadNo, logs = '', restartAttempts = 0, threadStarted = false) {
        const cypressProcess = spawn('bash', [
            path.resolve(__dirname, 'shell.sh'),
            // arguments for the shell script
            allureResultsPath || '',// $1
            threadsMeta[threadNo].cypressConfigFilepath || '',// $2
            threadsMeta[threadNo].cypressConfig,// $3
            threadNo,// $4
            threadsMeta[threadNo].browser || '',// $5
            threadsMeta[threadNo].mochaFile || '',// $6
            threadsMeta[threadNo].additionalCypressEnvArgs,// $7
        ]);

        threadsMeta[threadNo].pid = cypressProcess.pid;

        threadsMeta[threadNo].killFunc = () => {
            if (cypressProcess.pid) kill(cypressProcess.pid)
        }

        if (!threadsMeta[threadNo].retries) noOfThreadsInUse++;

        let restartTests = false;

        if (phaseLock && phaseLock < threadsMeta[threadNo].phaseNo) {//hack this is daft but it works. Prevent thread from running if a thread from a previous phase has already failed
            threadsMeta[threadNo].killFunc();
            return;
        }

        if (noOfThreadsInUse > 1 && logMode < 3 && !threadsMeta[threadNo].printedLogs) {
            if (logMode === 1) {
                console.log(`Thread #${threadNo} is now starting, and its logs will be printed when all preceding threads have completed.`);
            } else if (logMode === 2) {
                const fullQueue = [Object.values(threadsMeta).filter(thread => thread.printedLogs === 'some')].concat(logQueue);

                console.log(`Thread #${threadNo} is now starting, and its logs will be printed once thread${fullQueue.length !== 1 ? 's' : ''}${fullQueue.map(thread => thread.threadNo)} have printed their logs.`);
            }
        } else {
            console.log(`Thread #${threadNo} is now starting...`);
        }

        if (!threadsMeta[threadNo].retries) threadsMeta[threadNo].perfResults.startTime = performance.now();

        const customWarning = (str) => {
            console.warn(orange(str));
            logs += `${str}\n`;
        }

        const setThreadInactivityTimer = () => {
            if (!threadInactivityTimeout) return;

            clearTimeout(threadsMeta[threadNo].threadInactivityTimer);
            threadsMeta[threadNo].threadInactivityTimer = setTimeout(() => {
                customWarning(`The Cypress instance in thread #${threadNo} hasn\'t responded for ${secondsToNaturalString(threadInactivityTimeout)} and will be considered a crash.`);

                restartTests = true;

                threadsMeta[threadNo].killFunc();
            }, threadInactivityTimeout * 1000);
        };

        setThreadInactivityTimer();

        const setThreadTimeLimitTimer = () => {
            if (!threadTimeLimit || threadsMeta[threadNo].threadTimeLimitTimer) return;

            threadsMeta[threadNo].threadTimeLimitTimer = setTimeout(() => {
                customWarning(`CRITICAL ERROR: The Cypress instance in thread #${threadNo} has failed to complete within the maximum time limit of ${secondsToNaturalString(threadTimeLimit)}. It will now stop running immediately.`);

                threadsMeta[threadNo].status = 'error';
                threadsMeta[threadNo].errorType = 'timeout';
                exitCode = 1;

                restartTests = false;

                threadsMeta[threadNo].killFunc();
            }, threadTimeLimit * 1000);
        };

        setThreadTimeLimitTimer();

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

            setThreadInactivityTimer();

            logs += log;

            if (
                log.includes('uncaught error was detected outside of a test')
                || log.includes('we are skipping the remaining tests in the current suite')
                || log.includes('Cypress could not associate this error to any specific test.')
                || log.includes('Cypress: Fatal IO error')
                || log.includes('Webpack Compilation Error')
            ) {
                restartTests = true;

                threadsMeta[threadNo].killFunc();
            } else if (log.includes('no spec files were found')) {
                threadsMeta[threadNo].status = 'error';
                threadsMeta[threadNo].errorType = 'no-spec-files';

                threadsMeta[threadNo].killFunc();
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
            clearTimeout(threadsMeta[threadNo].threadTimeLimitTimer);
            printAllLogs();

            if (
                !threadsMeta[threadNo].logs.includes('All specs passed')
                && (!phaseLock || threadsMeta[threadNo].phaseNo < phaseLock)
                && threadsMeta[threadNo].phaseNo < Object.keys(cypressConfigPhasesSorted).length
            ) {
                phaseLock = threadsMeta[threadNo].phaseNo;

                const threadsFromPhasesAfterCurrent = Object.values(threadsMeta).filter(thread => thread.phaseNo > phaseLock);

                if (threadsFromPhasesAfterCurrent.length) {
                    customWarning(orange(`Thread #${threadNo} failed, and as it's from phase #${phaseLock}, all threads from following phases will be stopped immediately. Any remaining threads from phase ${phaseLock} will continue running.`))

                    threadsFromPhasesAfterCurrent.forEach((thread) => {
                        if (!threadsMeta[thread.threadNo].logs.includes('All specs passed')) {
                            threadsMeta[thread.threadNo].status = 'error';
                            threadsMeta[thread.threadNo].errorType = 'critical';
                            threadsMeta[thread.threadNo].perfResults.secs = undefined;
                            threadsMeta[thread.threadNo].perfResults.startTime = undefined;
                        }

                        threadsMeta[thread.threadNo].killFunc();
                    });
                }
            }

            writeFileSyncRecursive(path.join(threadLogsDir, `thread_${threadNo}.txt`), logs);

            // the thread might not have been marked as started if it never started properly!
            if (!threadStarted) threadStarted = true;

            noOfThreadsInUse--;
            threadDelayTout.clearTimeout();// todo this doesn't consider whether another thread is currently restarting and so may end a timeout early, but it doesn't really matter...
            threadsMeta[threadNo].complete = true;
            threadsMeta[threadNo].pid = false;
            threadsMeta[threadNo].perfResults.secs = timeDifference(performance.now(), threadsMeta[threadNo].perfResults.startTime);
        }

        return new Promise((resolve) => {
            cypressProcess.on('close', async () => {
                clearTimeout(threadsMeta[threadNo].threadInactivityTimer);

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
            if (noOfThreadsInUse < maxConcurrentThreads) {
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

            for (const [_, thread] of Object.values(threadsMeta).slice(2).entries()) {
                if (thread.skip) continue;

                await delay(threadDelay);

                if (!phaseLock || thread.phaseNo <= phaseLock) {//hack this is daft but it works
                    threadsArr.push(spawnThread(thread.threadNo));
                } else {
                    break;
                }
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

    console.log(`All Cypress testing threads have ended after ${secondsToNaturalString(timeDifference(performance.now(), startTime))}.`);

    let reportText = '';

    // bulk of multithread report logic
    {
        let longestThread = { secs: -1 };

        Object.values(threadsMeta).forEach((thread) => {
            const failedTests = {};
            let mostFailsForOneTest = 0;

            // record how many tests failed, and how many times!
            getFiles(
                path.join(allureResultsPath, String(thread.threadNo)),
            ).forEach((file) => {
                if (file.endsWith('.json')) {
                    try {// try catch as not all JSON files will be parseable
                        const { status, labels, fullName } = fs.readJsonSync(file);

                        if (
                            status
                            && labels
                            && fullName
                            && !['passed', 'skipped', 'unknown'].includes(status)
                        ) {
                            // ensure the key is wholly unique (in case two tests have the same title)
                            const key = `${fullName}${JSON.stringify(labels)}`;

                            if (!failedTests[key]) failedTests[key] = 1;
                            else failedTests[key] += 1;

                            if (failedTests[key] > mostFailsForOneTest) {
                                mostFailsForOneTest = failedTests[key];
                            }
                        }
                    } catch (err) { }
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
            benchmarkObj.order = [...new Set(Object.values(threadsMeta).filter(thread => thread.perfResults.secs).sort((a, b) => b.perfResults.secs - a.perfResults.secs).map(threadsMeta => threadsMeta.path))];

            if (benchmarkObj.order.length < 2) {
                console.log(orange('The thread benchmark will not be updated because two or more threads with different files are required to determine the optimal order!'));
            } else if (Object.values(threadsMeta).length !== benchmarkObj.order.length) {
                console.log(orange('The thread benchmark will not be updated because one or more phases did not complete!'));
            } else {
                if (JSON.stringify(savedThreadBenchmark[benchmarkId]) !== JSON.stringify(benchmarkObj)) {
                    console.log(`Updating thread order:\n["${benchmarkObj.order.join('", "')}"]`);

                    fs.writeFileSync(threadBenchmarkFilepath, `${JSON.stringify({
                        ...savedThreadBenchmark,
                        [benchmarkId]: benchmarkObj,
                    }, null, 4)}\n`);
                } else {
                    console.log('The results of the thread benchmark are identical to the records already saved, so the thread order doesn\'t need changing!');
                }
            }
        }

        // a visual representation of how each thread performed, to show where any bottlenecks lie
        const generateThreadBars = (timeOfLongestThread) => {
            let str = '';

            cypressConfigPhasesSorted.forEach((_, phaseIndex) => {
                const phaseNo = Number(phaseIndex) + 1;

                str += `[PHASE ${phaseNo}]\n\n`;

                const phaseThreads = Object.values(threadsMeta).filter(thread => thread.phaseNo === phaseNo);

                if (userSkippingPhase(phaseNo)) {
                    str += 'Phase skipped!\n\n';
                } else if (!phaseThreads.length) {
                    str += 'No spec files were found!\n\n';
                }

                phaseThreads.forEach((thread) => {
                    const threadPath = thread.path;

                    const threadId = Object.values(threadsMeta).length > 9 ? String(thread.threadNo).padStart(2, '0') : thread.threadNo;

                    const shortThreadPath = threadPath.length > 60
                        ? `...${threadPath.substring(threadPath.length - 57).match(/\/(.*)$/)?.[0] || threadPath.substring(threadPath.length - 57)}`
                        : threadPath;

                    threadsMeta[thread.threadNo].heading = [`Thread #${threadId} [${shortThreadPath}]`];

                    str += `Thread #${threadId} [${threadPath}]\n`;

                    if (threadsMeta[thread.threadNo].errorType === 'no-spec-files') {
                        const err = 'ERROR: No spec files found!';
                        threadsMeta[thread.threadNo].status = 'error';
                        threadsMeta[thread.threadNo].heading.push(err);
                        threadsMeta[thread.threadNo].summary = `ERROR: No spec files were found for thread #${thread.threadNo}`;
                        str += `${err}\n\n`;
                        exitCode = 1;
                    } else if (threadsMeta[thread.threadNo].errorType === 'critical') {
                        const err = 'CRITICAL ERROR: Thread did not complete!';
                        threadsMeta[thread.threadNo].status = 'error';
                        threadsMeta[thread.threadNo].heading.push(err);
                        str += `${err}\n\n`;
                        exitCode = 1;
                    } else if (threadsMeta[thread.threadNo].errorType === 'timeout') {
                        const err = `CRITICAL ERROR: Thread did not complete as it went over the time limit of ${secondsToNaturalString(threadTimeLimit)}`;
                        threadsMeta[thread.threadNo].status = 'error';
                        threadsMeta[thread.threadNo].heading.push(err);
                        str += `${err}\n\n`;
                        exitCode = 1;
                    }

                    const percentageOfTotal = (
                        threadsMeta[thread.threadNo].perfResults.secs / timeOfLongestThread
                    ) * 100;

                    if (isNaN(percentageOfTotal)) {
                        return;
                    }

                    // log if any tests in the thread failed/retried
                    const reportFailedTests = (obj) => {
                        const result = [];

                        if (Object.entries(obj).length) {
                            if (threadsMeta[thread.threadNo].status !== 'error') threadsMeta[thread.threadNo].status = 'warn';

                            const counts = Object.values(obj).reduce((acc, curr) => {
                                acc[curr] = (acc[curr] || 0) + 1;
                                return acc;
                            }, {});

                            Object.keys(counts).sort((a, b) => b - a).forEach((num) => {
                                result.push(`${counts[num]} test${counts[num] > 1 ? 's' : ''} failed ${num} time${num > 1 ? 's' : ''}`);
                            });
                        }

                        if (threadsMeta[thread.threadNo].retries) {
                            if (threadsMeta[thread.threadNo].retries === maxThreadRestarts) {
                                result.push(`the thread crashed ${maxThreadRestarts} time${maxThreadRestarts === 1 ? '' : 's'}, never recovering`);
                            } else {
                                if (threadsMeta[thread.threadNo].status !== 'error') threadsMeta[thread.threadNo].status = 'warn';

                                result.push(`the thread needed restarting ${threadsMeta[thread.threadNo].retries} time${threadsMeta[thread.threadNo].retries === 1 ? '' : 's'}`);
                            }
                        }

                        if (!result.length) {
                            return '';
                        }

                        threadsMeta[thread.threadNo].heading.push(`WARNING: ${arrToNaturalStr(result)}`);
                        threadsMeta[thread.threadNo].summary = `WARNING: Thread #${thread.threadNo}: ${arrToNaturalStr(result)}`;

                        return ` (WARNING: ${arrToNaturalStr(result)})`;
                    };

                    str += `${generatePercentageBar(percentageOfTotal, threadsMeta[thread.threadNo].perfResults.secs)}${reportFailedTests(threadsMeta[thread.threadNo].perfResults.failedTests)}\n\n`;
                });
            });

            return str;
        };

        reportText = `See below to compare how each thread performed.\n\n${generateThreadBars(longestThread.secs)}The percentages given above represent how much time individual threads took to complete relative to thread #${longestThread.threadNo}, which was the longest at ${longestThread.naturalString}. Any thread that takes significantly longer than others will be a bottleneck, so the closer the percentages are to one another, the better. A wide range in percentages indicates that the threads could be balanced more efficiently. Be alert as to whether any thread/test needed retrying, because that will skew the results for the affected threads.`;

        console.log(`\n\n${reportText}\n\n`);

        // save these logs for future reference!
        fs.writeFileSync(path.resolve(reportDir, 'thread-performance-report.txt'), reportText);
    }

    // Overwrite the historyIds in the Allure results, as the Allure plugin's method is flawed.
    // Doing this ensures tests across identical names are included in the report
    // NOTE: Tests with identical names must be in different describe blocks and/or spec files
    getFiles(allureResultsPath).forEach((file) => {
        if (!file.endsWith('.json')) return;

        try {// try catch as not all JSON files will be parseable
            const data = fs.readJsonSync(file);

            const { labels, fullName } = data;

            if (data.historyId && labels.length) {
                data.historyId = Buffer.from(JSON.stringify(labels.concat(fullName))).toString('base64');

                fs.writeFileSync(file, JSON.stringify(data));
            }
        } catch (err) { }
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

    if (fullConfig.jUnitReport?.enabled) {
        const { mergeFiles } = require('junit-report-merger');

        const outputFile = path.join(reportDir, 'combined-junit-report.xml');

        try {
            await mergeFiles(outputFile, [path.join(jUnitReportDir, '*.xml')]);

            fs.writeFileSync(
                outputFile,
                fs.readFileSync(outputFile)
                    .toString('utf8')
                    .replace(/<\/>/gm, '')// hack to remove a dodgy tag that breaks the report
            );
        } catch (err) {
            console.error(red(`ERROR: JUnit report merge failed:`), err);
        }

        const browserStackObservability = fullConfig.jUnitReport?.browserStackTestObservabilityUpload;

        if (browserStackObservability) {
            const outputFileBSO = path.join(path.dirname(outputFile), path.basename(outputFile).replace('.xml', '-bso.xml'));

            const endpoint = browserStackObservability.endpoint || 'https://upload-observability.browserStack.com/upload';

            try {
                fs.writeFileSync(
                    outputFileBSO,
                    fs.readFileSync(outputFile)
                        .toString('utf8')
                        .replace(/timestamp="(.*?)"( *|)/gmi, '')// BrowserStack observability doesn't like timestamps!
                        .replace(/name="([^"]+)"/g, (_match, nameValue) => {
                            const sanitisedName = nameValue.replace(/[^a-zA-Z0-9^ \[\]:-_]/g, "-");
                            return `name="${sanitisedName}"`;
                        })
                );

                runShellCommand(`curl -u "${browserStackObservability.username}:${browserStackObservability.accessKey}" -vvv -X POST -F "data=@${path.basename(outputFileBSO)}" ${Object.keys(browserStackObservability.parameters || {}).map(key => `-F "${key}=${browserStackObservability.parameters[key]}"`).join(' ')} ${endpoint}`, path.dirname(outputFileBSO))

                console.log(`\n\nUploaded JUnit report to ${endpoint}\n`);
            } catch (err) {
                console.error(red(`ERROR: JUnit report failed to upload to ${endpoint}:`), err);
            }
        }
    }

    if (generateAllure) {
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

                threadsMeta[threadNo].logs = `<div class="cmr-thread cmr-${threadsMeta[threadNo].status}"><span class="cmr-pre-heading cmr-sticky"><h2 id="cmr-arr-${threadNo}">➡️</h2><h2>${threadsMeta[threadNo].heading.join('<br>')}</h2></span><pre id="cmr-pre-${threadNo}" style="display:none">${threadNo === '2' && thread2ExtraLog ? `${thread2ExtraLog}\n` : ''}${fs.readFileSync(file).toString('utf8').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></div>`;
            });

            Object.values(threadsMeta).forEach(thread => {
                if (thread.logs) {
                    allLogs += thread.logs;
                }
            })

            const criticalErrorThreads = Object.entries(threadsMeta).filter(o => o[1].errorType === 'critical').map(o => o[0]);
            const timeoutErrorThreads = Object.entries(threadsMeta).filter(o => o[1].errorType === 'timeout').map(o => o[0]);

            const minorErrorThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'error').filter(o => !['critical', 'timeout'].includes(o[1].errorType)).map(o => o[0]);
            const allErrorThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'error').map(o => o[0]);
            const warnThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'warn').map(o => o[0]);

            const status = (() => {
                if (allErrorThreads.length) return 'error';
                if (warnThreads.length) return 'warn';
                return 'success';
            })();

            const cmrAllureBody = `<body>
                <div class="cmr-content cmr-header">
                    <div class="cmr-${status} cmr-headline"><h2 id="cmr-collapse">⬇️</h2><h2>Cypress Multithreaded Runner${allureReportHeading}${(criticalErrorThreads.length || timeoutErrorThreads.length) ? ' [CRITICAL ERRORS - PLEASE READ]' : ''}</h2></div>
                    ${(criticalErrorThreads.length || timeoutErrorThreads.length) ? `
                    <div class="cmr-error cmr-summary">
                        Be advised! This Allure report doesn't tell the full story. ${phaseLock ? `One or more tests in <strong>phase #${phaseLock} failed</strong>, therefore any tests from threads in subsequent phases did not complete. They'll all be marked as having critical errors.<br><br>` : ''}${criticalErrorThreads.length ? ` <strong>Thread ${arrToNaturalStr(criticalErrorThreads.map(num => `#${num}`))} had ${criticalErrorThreads.length > 1 ? 'critical errors' : 'a critical error'}</strong> and didn't complete!` : ''}${timeoutErrorThreads.length ? ` <strong>Thread ${arrToNaturalStr(timeoutErrorThreads.map(num => `#${num}`))} ${timeoutErrorThreads.length > 1 ? 'were' : 'was'} stopped early</strong> because ${timeoutErrorThreads.length > 1 ? 'they each' : 'it'} failed to complete within the maximum time limit of ${secondsToNaturalString(threadTimeLimit)}.` : ''} Therefore, one or more spec files may have not been fully tested! Scroll down to read the full logs from the separate threads.
                    </div>` : ''}
                    ${minorErrorThreads.length ? `
                    <div class="cmr-error cmr-summary">
                        ${minorErrorThreads.map(threadNo => threadsMeta[threadNo].summary).join('<br>')}${(!criticalErrorThreads.length && !timeoutErrorThreads.length) ? '<br>Scroll down to read the full logs from the separate threads.' : ''}
                    </div>` : ''}
                    ${warnThreads.length ? `
                    <div class="cmr-warn cmr-summary">
                        ${warnThreads.map(threadNo => threadsMeta[threadNo].summary).join('<br>')}${status === 'warn' ? '<br>Scroll down to read the full logs from the separate threads.' : ''}
                    </div>` : ''}
                    ${status === 'success' ? `
                    <div class="cmr-success cmr-summary">
                        Everything seems completely fine! No tests needed retrying. Scroll down to read the full logs from the separate threads.
                    </div>
                    `: ''}
                    ${reportHeadNotes.length ? `
                    <div class="cmr-notes cmr-summary">
                        ${reportHeadNotes.map(note => `NOTE: ${note}`).join('<br>')}
                    </div>` : ''}
                </div>`;

            const cmrAllureFooter = `<div class="cmr-content cmr-footer">${allLogs
                .replace(/Couldn't find tsconfig.json. tsconfig-paths will be skipped\n/g, '')// this warning is noisy, remove it
                .replace(/tput: No value for \$TERM and no -T specified\n/g, '')// this warning is noisy, remove it
                }<div class="cmr-report"><button id="cmr-open-all">Open all logs above</button><button id="cmr-close-all">Close all logs above</button><br><br><h2 class="cmr-sticky">Thread Performance Summary</h2><pre>${reportText}</pre></div></div>
                
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

                    .cmr-header h2 {
                        margin: 0;
                        display: inline-block;
                    }
                
                    .cmr-content div:nth-child(even) {
                        filter: brightness(0.92);
                    }
                
                    .cmr-content pre {
                        overflow-wrap: break-word;
                    }

                    #cmr-collapse {
                        padding-right: 10px;
                    }

                    .cmr-headline h2 {
                        cursor: pointer;
                    }
                
                    .cmr-content div {
                        padding: 20px;
                        background: white;
                        min-width: 890px;
                    }

                    .cmr-hidden {
                        display: none;
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
                    }

                    .cmr-content .cmr-sticky {
                        display: flex;
                        gap: 10px;
                        position: sticky;
                        top: 0;
                        margin-left: -1px;
                        padding-left: 1px;
                        background: inherit;
                    }

                    .cmr-content button {
                        background: rgb(239, 239, 239);
                        border: 1px solid grey;
                        padding: 5px;
                        border-radius: 6px;
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

                    function getScrollHeightFromBottom(){
                        return Math.ceil(document.documentElement.scrollHeight - window.innerHeight - window.pageYOffset);
                    }

                    document.querySelector('#cmr-open-all').addEventListener('click', () => {
                        const scrollBef=getScrollHeightFromBottom();
                        [...document.querySelectorAll('.cmr-pre-heading:not(.cmr-pre-heading-active)')].forEach((heading)=>{heading.click()});
                        window.scrollTo(0,999999999);
                        window.scrollBy(0,-scrollBef);
                    });

                    document.querySelector('#cmr-close-all').addEventListener('click', () => {
                        const scrollBef=getScrollHeightFromBottom();
                        [...document.querySelectorAll('.cmr-pre-heading-active')].forEach((heading)=>{heading.click()});
                        window.scrollTo(0,999999999);
                        window.scrollBy(0,-scrollBef);
                    });

                    const cmrHeadline = document.querySelector('div.cmr-content > :first-child');
                    cmrHeadline.addEventListener('click', (event) => {
                        document.querySelectorAll('.cmr-summary').forEach(element => {
                            element.classList.toggle('cmr-hidden');
                        });

                        let collapseIcon = document.querySelector('#cmr-collapse');
                        collapseIcon.innerText = collapseIcon.innerText === '⬇️' ? '➡️' : '⬇️';
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
                    runShellCommand('pip install --upgrade allure-combine && allure-combine allure-report');

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
                runShellCommand('allure open', path.resolve(reportDir));
            } else if (openAllure) {
                if (combinedAllureSuccessfully) {
                    runShellCommand(`open "${allureReportHtmlComplete}"`);
                } else {
                    runShellCommand(`open "${allureReportHtml}"`);
                }
            }

            console.log(green(`The Allure report for this run has been saved to the following directory: "${allureReportDir}"`));
        }
    }

    if (fullConfig.waitForFileExist?.deleteAfterCompletion) {
        if (fs.existsSync(waitForFileExistFilepath)) {
            fs.unlinkSync(waitForFileExistFilepath);
        }
    }

    if (endProcessIfTestsFail && exitCode) {
        process.exit(exitCode);
    }

    return new Promise((resolve) => resolve(exitCode));
}
