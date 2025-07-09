// NOTE: Comments and general structure of this file are WIP

const { importAll } = require('./lib/importAll.js');
importAll().from('./common.js');

const fs = require('fs-extra');

const { execSync, spawn } = require('child_process');

const killSync = require('kill-sync');
const kill = (pid) => killSync(pid, 'SIGKILL', true);

const path = require('path');

const defaultLog = console.log;

const notifier = require('node-notifier');

const events = require('events');

/**
 * Recursively create a path if it doesn't exist
 * 
 * @param {string} str the path to check and create
 */
const mkdirSyncIfMissing = (s) => !fs.existsSync(s) && fs.mkdirSync(s, { recursive: true });

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

// const getDirectories = (srcpath) => (
//     fs.existsSync(srcpath) ? fs.readdirSync(srcpath) : []
// ).map((file) => path.join(srcpath, file))
//     .filter((filepath) => fs.statSync(filepath).isDirectory());

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

const getTimeStr = () => {
    const t = new Date();

    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
}

/**
 * Safe method to recursively delete empty directories
 */
const deleteEmptyFoldersRecursively = (folder) => {
    const isDir = fs.statSync(folder).isDirectory();

    if (!isDir) {
        return;
    }

    let files = fs.readdirSync(folder).filter((file) => file !== '.DS_Store');

    if (files.length) {
        files.forEach((file) => {
            const fullPath = path.join(folder, file);
            deleteEmptyFoldersRecursively(fullPath);
        });

        files = fs.readdirSync(folder).filter((file) => file !== '.DS_Store');
    }

    if (!files.length) {
        // console.log(`Deleting empty dir: ${folder}`);
        fs.rmSync(folder, { recursive: true });
    }
}

module.exports = async (config = {}) => {
    const startTime = performance.now();
    const timestamp = Date.now();

    const fullConfig = getFullConfig(config);

    const reportDir = fullConfig.reportDir;
    const maxThreadRestarts = fullConfig.maxThreadRestarts ?? 5;
    const waitForFileExistTimeout = fullConfig.waitForFileExist?.timeout ?? 60;
    const waitForFileMinimumSize = fullConfig.waitForFileExist?.minSize ?? 2;
    const waitForFileExistFilepath = fullConfig.waitForFileExist?.filepath;
    const stopWaitingForFileWhenFirstThreadCompletes = fullConfig.waitForFileExist?.stopWaitingWhenFirstThreadCompletes ?? true;

    const threadInactivityTimeout = fullConfig.threadInactivityTimeout ?? 60 * 10;
    const threadTimeLimit = fullConfig.threadTimeLimit ?? 60 * 30;
    const maxAllowedTimeouts = fullConfig.maxAllowedTimeouts ?? 4;

    let threadTimeoutCount = 0;

    const clean = fullConfig.clean;
    const threadDelay = (fullConfig.threadDelay ?? 30) * 1000;
    const logMode = fullConfig.logMode || 1;
    const allureReportHeading = fullConfig.allureReportHeading;
    const orderThreadsByBenchmark = fullConfig.orderThreadsByBenchmark ?? true;
    const saveThreadBenchmark = fullConfig.saveThreadBenchmark ?? true;
    const threadBenchmarkFilepath = fullConfig.threadBenchmarkFilepath || 'cmr-benchmarks.json';
    const benchmarkDescription = fullConfig.benchmarkDescription ?? null;

    const customLogs = fullConfig.customLogs || [];

    const verboseLog = (...log) => {
        if (fullConfig.verbose) {
            console.log(cyan(log.join(' ')));
        }
    }

    const specFiles = await (async () => {
        if (!fullConfig.runFailedSpecFilesFromReportURL) {
            return fullConfig.specFiles ?? null;
        }

        let htmlStr = '';

        async function curlFile() {
            const testy = spawn('bash', [
                path.resolve(__dirname, 'shell', 'curl.sh'),
                fullConfig.runFailedSpecFilesFromReportURL
            ]);

            testy.stdout.on('data', (data) => htmlStr += `${data.toString()}\n`);

            return new Promise((resolve) => {
                testy.on('close', () => {
                    resolve();
                });
            });
        }

        await curlFile();

        const { parse } = require('node-html-parser');

        let files = null;

        try {
            files = JSON.parse(parse(htmlStr).querySelector('#cmr-run-config').textContent.replace(/\n/g, '')).fails;
        } catch (err) {
            throw new Error(`Failed to parse the report URL "${fullConfig.runFailedSpecFilesFromReportURL}"`);
        }

        if (!files.length) {
            throw new Error(`No failed spec files were found in the report URL "${fullConfig.runFailedSpecFilesFromReportURL}"`);
        } else {
            console.log(`${files.length} failed spec file${files.length === 1 ? '' : 's'} were found in the report URL "${fullConfig.runFailedSpecFilesFromReportURL}":\n${files.join('\n')}\n`)
        }

        return files;
    })();

    const notifications = fullConfig.notify ?? true;

    const generateAllure = fullConfig.generateAllure;

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

                const arrStr = [
                    grepTags,
                    grep,
                    grepUntagged,
                    `timestamp="${timestamp}"`,
                    passthroughEnvArgs
                ].filter(str => str).join(',');

                if (!arrStr) return '';

                return `,${arrStr}`
            })(),
        }
    });

    const benchmarkObj = filterObj({
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

    const benchmarkId = benchmarkDescription || btoa(JSON.stringify(benchmarkObj));

    const openAllure = fullConfig.openAllure;
    const combineAllure = fullConfig.combineAllure ?? true;
    const hostAllure = fullConfig.hostAllure ?? false;

    const defaultAllureReportDir = fullConfig.defaultAllureReportDir;
    const allureReportDir = fullConfig.allureReportDir;
    const defaultAllureHistoryDir = path.resolve(fullConfig.reportDir, 'allure-results', 'history');
    const allureHistoryDir = fullConfig.allureHistoryDir ?? defaultAllureHistoryDir;
    const overwriteAllureHistory = fullConfig.overwriteAllureHistory ?? true;
    const jUnitReportDir = path.join(reportDir, 'junit');

    const threadLogsDir = path.join(reportDir, 'cypress-logs');

    const runShellCommand = (
        cmd,
        cwd = fs.existsSync(reportDir) ? path.resolve(reportDir) : undefined,
        returnOutput = false,
    ) => {
        if (!returnOutput) {
            execSync(cmd, {
                cwd,
                stdio: [null, process.stdout, process.stderr]
            });
            return;
        }

        return execSync(cmd, {
            cwd,
        });
    };

    let thread2ExtraLog = '';

    let exitCode = 0;

    const notify = (message) => {
        if (notifications && !fullConfig.maxConcurrentThreadsExperimentInProg) {
            notifier.notify(
                {
                    title: 'Cypress Multithreaded Runner',
                    message,
                    sound: true,
                },
            );
        }
    }

    if (fullConfig.maxConcurrentThreadsExperiment && !fullConfig.maxConcurrentThreadsExperimentInProg) {
        console.warn(orange('WARNING: maxConcurrentThreadsExperiment will not work when run through the async mode'));
    }

    const cypressConfigPhasesUnsorted = phases.map(phase => {
        const specs = getFilesRecursive(phase.specsDir)

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
        notify('No test phases were found');
        process.exit(1);
    }

    const cypressConfigPhasesSorted = [];

    // raw test results are saved to this directory, which are then used to create the Allure report
    const allureResultsPath = path.resolve(reportDir, 'allure-results');

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
        initLogs.push(`[PHASE ${phaseNo}]`);

        let skipLoop = false;

        if (!phase.length) {
            initLogs[initLogs.length - 1] += ' (No spec files found, skipping)';
            skipLoop = true;
        }

        if (userSkippingPhase(phaseNo)) {
            initLogs[initLogs.length - 1] += ' (Skipping phase)';
            skipLoop = true;
        }

        if (!skipLoop) {
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
                        logsTimestamped: [],
                        printedLogs: false,
                        additionalCypressEnvArgs: phases[phaseIndex].additionalCypressEnvArgs,
                        mochaFile: fullConfig.jUnitReport?.enabled ? path.join(jUnitReportDir, `${String(threadNo)}.xml`) : null,
                        killFunc: () => { threadsMeta[threadNo].skip = true }
                    }

                    initLogs[initLogs.length - 1] += `\nThread ${threadNo}: "${threadPath}"${!savedThreadBenchmark[benchmarkId]?.order.includes(threadPath) ? ' (not found in benchmark)' : ''}`;
                });
            }
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
        notify('No spec files were found');
        process.exit(1);
    }

    // needed if a Cypress instance doesn't log anything but the shellscript still wants to write to the report directory
    mkdirSyncIfMissing(reportDir);

    const threadDelayTout = (new SuperTout);

    let logQueue = [];

    let phaseLock;

    const customWarning = (threadNo, log) => {
        console.warn(orange(log));
        threadsMeta[threadNo].logsTimestamped.push([
            getTimeStr(),
            log.startsWith('\n') && log.trim() ? `\n${log}` : log // this keeps the extra line if the log starts with one
        ]);
    }

    async function spawnThread(threadNo, restartAttempts = 0, threadStarted = false) {
        let restartTests = false;

        if (threadsMeta[threadNo].pid) {// failsafe
            kill(threadsMeta[threadNo].pid);
            threadsMeta[threadNo].pid = false;
        }

        if (
            threadsMeta[threadNo].errorType === 'timeout'
            || (phaseLock && phaseLock < threadsMeta[threadNo].phaseNo)
            || (threadTimeoutCount > maxAllowedTimeouts)
        ) {//hack this is daft but it works. Prevent thread from running if a thread from a previous phase has already failed
            verboseLog(`killFunc on thread #${threadNo} before spawn`)
            threadsMeta[threadNo].killFunc();
            return;
        }

        const cypressProcess = spawn('bash', [
            path.resolve(__dirname, 'shell', 'cypress.sh'),
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
        threadsMeta[threadNo].emitter = new events.EventEmitter();

        const retriesOnStart = threadsMeta[threadNo].retries;

        threadsMeta[threadNo].fallbackCloseFunc = (bypassTimeout) => {
            clearTimeout(threadsMeta[threadNo].fallbackCloseTimer);

            const exitFunc = () => {
                if (threadsMeta[threadNo].pid) {
                    console.warn(`Fallback exit function started on thread #${threadNo} (pid: ${threadsMeta[threadNo].pid})`);
                    kill(threadsMeta[threadNo].pid); // failsafe (might not be needed)
                } else {
                    console.warn(`Fallback exit function started on thread #${threadNo}`);
                }

                // if thread has since been restarted since this fallback function was called, don't stop the thread!
                if (retriesOnStart !== threadsMeta[threadNo].retries) {
                    console.log(`Fallback exit cancelled; thread #${threadNo} has already restarted`);
                    return;
                }

                console.warn(`Fallback exit emitted on thread #${threadNo}`);
                threadsMeta[threadNo].emitter.emit('exit');
            }

            if (bypassTimeout) {
                exitFunc();
                return;
            }

            threadsMeta[threadNo].fallbackCloseTimer = setTimeout(() => {
                exitFunc();
            }, 5000);
        }

        threadsMeta[threadNo].killFunc = (bypassTimeout) => {
            if (threadsMeta[threadNo].pid) {
                threadsMeta[threadNo].fallbackCloseFunc(bypassTimeout);
                console.warn(`Force stop thread #${threadNo} (pid: ${threadsMeta[threadNo].pid})`);
                kill(threadsMeta[threadNo].pid);
            }
        }

        if (!threadsMeta[threadNo].retries) noOfThreadsInUse++;

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

        const setThreadInactivityTimer = () => {
            if (!threadInactivityTimeout) return;

            clearTimeout(threadsMeta[threadNo].threadInactivityTimer);
            threadsMeta[threadNo].threadInactivityTimer = setTimeout(() => {
                customWarning(threadNo, `The Cypress instance in thread #${threadNo} hasn\'t responded for ${secondsToNaturalString(threadInactivityTimeout)} and will be considered a crash.`);

                restartTests = true;
                verboseLog(`Thread #${threadNo} inactivity killFunc`)

                threadsMeta[threadNo].killFunc();
            }, threadInactivityTimeout * 1000);
        };

        setThreadInactivityTimer();

        const setThreadTimeLimitTimer = () => {
            if (!threadTimeLimit || threadsMeta[threadNo].threadTimeLimitTimer) return;

            threadsMeta[threadNo].threadTimeLimitTimer = setTimeout(() => {
                threadsMeta[threadNo].status = 'error';
                threadsMeta[threadNo].errorType = 'timeout';
                exitCode = 1;
                restartTests = false;
                threadTimeoutCount++;

                if (threadTimeoutCount > maxAllowedTimeouts) {
                    customWarning(threadNo, `CRITICAL ERROR: The Cypress instance in thread #${threadNo} has failed to complete within the maximum time limit of ${secondsToNaturalString(threadTimeLimit)}. ${threadTimeoutCount} thread${threadTimeoutCount === 1 ? ' has' : 's have'} timed out, and the maximum number of threads allowed to time out is ${maxAllowedTimeouts}, so all threads will stop running.`);

                    threadsMeta[threadNo].status = 'error';

                    if (!phaseLock || threadsMeta[threadNo].phaseNo < phaseLock) {
                        phaseLock = threadsMeta[threadNo].phaseNo;
                    }

                    Object.values(threadsMeta).forEach((thread) => {
                        if (!threadsMeta[thread.threadNo].complete && threadsMeta[thread.threadNo].errorType !== 'timeout') {
                            threadsMeta[thread.threadNo].status = 'error';
                            threadsMeta[thread.threadNo].errorType = 'critical';
                            threadsMeta[thread.threadNo].perfResults.secs = undefined;
                            threadsMeta[thread.threadNo].perfResults.startTime = undefined;
                            clearTimeout(threadsMeta[thread.threadNo].threadTimeLimitTimer);//todo move into killfunc
                            threadsMeta[thread.threadNo].killFunc();
                        }
                    });
                } else {
                    customWarning(threadNo, `CRITICAL ERROR: The Cypress instance in thread #${threadNo} has failed to complete within the maximum time limit of ${secondsToNaturalString(threadTimeLimit)}. It will now stop running immediately. All threads will stop running if ${(maxAllowedTimeouts + 1) - threadTimeoutCount} more thread${((maxAllowedTimeouts + 1) - threadTimeoutCount) === 1 ? ' times out' : 's time out'}!`);
                }
                verboseLog(`Thread #${threadNo} timeout killFunc`)
                threadsMeta[threadNo].killFunc();
            }, threadTimeLimit * 1000);
        };

        setThreadTimeLimitTimer();

        // detect known internal errors and restart the tests when they occur!
        const logCheck = async (log) => {
            if (log.includes('<FALLBACK_SHELL_EXIT>')) {
                threadsMeta[threadNo].fallbackCloseFunc();
                return;
            }

            threadsMeta[threadNo].logs += log;
            threadsMeta[threadNo].logsTimestamped.push([getTimeStr(), log.startsWith('\n') && log.trim() ? `\n${log}` : log]);

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

            const logLC = log.toLowerCase();

            if (
                logLC.includes('uncaught error was detected outside of a test')
                || logLC.includes('we are skipping the remaining tests in the current suite')
                || logLC.includes('we have failed the current spec')
                || logLC.includes('we detected that the chromium renderer process just crashed')
                || logLC.includes('cypress could not associate this error to any specific test.')
                || logLC.includes('cypress: fatal io error')
                || logLC.includes('webpack compilation error')
                || logLC.includes('this error occurred during a `before all`')
            ) {
                restartTests = true;
                verboseLog(`Internal Cypress error on thread #${threadNo}`, logLC);

                threadsMeta[threadNo].killFunc();
            } else if (logLC.includes('no spec files were found')) {
                threadsMeta[threadNo].status = 'error';
                threadsMeta[threadNo].errorType = 'no-spec-files';
                verboseLog(`No spec files detected on thread #${threadNo}`);

                threadsMeta[threadNo].killFunc();
            } else if (!threadStarted && logLC.includes('(run starting)')) {
                threadStarted = true;
                verboseLog(`Detect run start on thread #${threadNo}`);
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

        const threadCompleteFunc = (forceFail) => {
            clearTimeout(threadsMeta[threadNo].threadTimeLimitTimer);
            printAllLogs();

            if (threadTimeoutCount <= maxAllowedTimeouts
                && (!threadsMeta[threadNo].logs.includes('All specs passed') || forceFail)) {
                threadsMeta[threadNo].status = 'error';

                if (
                    (!phaseLock || threadsMeta[threadNo].phaseNo < phaseLock)
                    && threadsMeta[threadNo].phaseNo < Object.keys(cypressConfigPhasesSorted).length
                ) {
                    phaseLock = threadsMeta[threadNo].phaseNo;

                    const threadsFromPhasesAfterCurrent = Object.values(threadsMeta).filter(thread => thread.phaseNo > phaseLock);

                    if (threadsFromPhasesAfterCurrent.length) {
                        customWarning(threadNo, `Thread #${threadNo} failed, and as it's from phase #${phaseLock}, all threads from following phases will be stopped immediately. Any remaining threads from phase ${phaseLock} will continue running.`)

                        threadsFromPhasesAfterCurrent.forEach((thread) => {
                            if (!threadsMeta[thread.threadNo].complete && threadsMeta[thread.threadNo].errorType !== 'timeout') {
                                threadsMeta[thread.threadNo].status = 'error';
                                threadsMeta[thread.threadNo].errorType = 'critical';
                                threadsMeta[thread.threadNo].perfResults.secs = undefined;
                                threadsMeta[thread.threadNo].perfResults.startTime = undefined;
                                clearTimeout(threadsMeta[thread.threadNo].threadTimeLimitTimer);//todo move into killfunc
                            }
                            verboseLog(`Thread #${thread.threadNo} is after phase ${phaseLock}: killFunc`)

                            threadsMeta[thread.threadNo].killFunc();
                        });
                    }
                }
            }

            writeFileSyncRecursive(path.join(threadLogsDir, `thread_${threadNo}.txt`), threadsMeta[threadNo].logs);

            // the thread might not have been marked as started if it never started properly!
            if (!threadStarted) threadStarted = true;

            noOfThreadsInUse--;
            threadDelayTout.clearTimeout();// todo this doesn't consider whether another thread is currently restarting and so may end a timeout early, but it doesn't really matter...
            threadsMeta[threadNo].complete = true;
            threadsMeta[threadNo].pid = false;
            threadsMeta[threadNo].perfResults.secs = calcTimeDifference(performance.now(), threadsMeta[threadNo].perfResults.startTime);
        }

        return new Promise((resolve) => {
            cypressProcess.on('close', () => {
                threadsMeta[threadNo].emitter.emit('exit');
            });

            threadsMeta[threadNo].emitter.on('exit', async () => {
                clearTimeout(threadsMeta[threadNo].threadInactivityTimer);
                clearTimeout(threadsMeta[threadNo].fallbackCloseTimer);

                if (
                    threadsMeta[threadNo].errorType !== 'timeout' &&
                    restartTests
                    || (
                        !threadsMeta[threadNo].errorType
                        && !threadsMeta[threadNo].logs.includes('(Run Finished)')
                    )
                ) {
                    restartAttempts++;
                    threadsMeta[threadNo].retries++;

                    if (restartAttempts < maxThreadRestarts) {
                        threadsMeta[threadNo].status = 'warn';

                        customWarning(threadNo, `WARNING: Internal Cypress error in thread #${threadNo}! Will retry a maximum of ${maxThreadRestarts - restartAttempts} more time${(maxThreadRestarts - restartAttempts) !== 1 ? 's' : ''}.`);

                        // delete any test results as they'll interfere with the next run
                        if (fs.pathExistsSync(path.join(allureResultsPath, String(threadNo)))) {
                            fs.rmSync(path.join(allureResultsPath, String(threadNo)), { recursive: true, force: true });
                        }

                        await spawnThread(threadNo, restartAttempts, threadStarted);
                    } else {
                        threadsMeta[threadNo].status = 'error';
                        threadsMeta[threadNo].errorType = 'critical';
                        exitCode = 1;

                        customWarning(threadNo, `CRITICAL ERROR: Too many internal Cypress errors in thread #${threadNo}. Giving up after ${maxThreadRestarts} attempts!`);
                        threadCompleteFunc(true);
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
                    customWarning(2, `WARNING: There may be an issue as the first thread has completed but the "${waitForFileExistFilepath}" file doesn't exist... will continue anyway!`)
                    clearInterval(interv);
                    resolve();
                } else {
                    waitForFileExistRemainingTime -= 0.5;

                    if (waitForFileExistRemainingTime <= 0) {
                        customWarning(2, `WARNING: There may be an issue as the "${waitForFileExistFilepath}" file doesn't exist after ${waitForFileExistTimeout} seconds... will continue anyway!`)

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
        }, ms > 0 ? ms : 0));
    }

    async function runCypressTests() {
        let threadsArr = []
        threadsArr.push(spawnThread(1));

        if (Object.values(threadsMeta).length > 1) {
            if (waitForFileExistFilepath) {
                // decrease total delay by .5s as waitForFileExist will check for the file in intervals of .5s
                await delay(threadDelay - 500);

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

    if (clean) {
        fs.rmSync(reportDir, { recursive: true });
    }

    if (
        allureHistoryDir
        && allureHistoryDir !== defaultAllureHistoryDir
        && fs.existsSync(allureHistoryDir)
    ) {
        fs.copySync(
            allureHistoryDir,
            defaultAllureHistoryDir,
            { overwrite: true }
        );
    }

    await runCypressTests();

    Object.values(threadsMeta).forEach(thread => {// failsafe; make sure all timeouts have stopped
        thread.killFunc(true);
    });

    if (logMode === 4) {
        Object.values(threadsMeta).forEach(thread => {
            process.stdout.write(thread.logs);
        })
    }

    console.log(`All Cypress testing threads have ended after ${secondsToNaturalString(calcTimeDifference(performance.now(), startTime))}.`);

    let reportText = '';

    const threadSummary = {
        nospecs: 0,
        criticals: 0,
        timeouts: 0,
        unknowns: 0,
        criticalsArr: [],
        crashes: {},
        crashSummary: [],
        fails: {},
        failSummary: []
    };

    // bulk of multithread report logic
    {
        let longestThread = { secs: -1 };

        Object.values(threadsMeta).forEach((thread) => {
            const failedTests = {};
            let mostFailsForOneTest = 0;

            let verifiedThread = false;

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

                        verifiedThread = true;
                    } catch (err) { }
                }

                // files from all threads need to be in the same directory to construct the Allure report
                fs.moveSync(
                    file,
                    path.resolve(allureResultsPath, path.basename(file)),
                    { overwrite: true },
                );
            });

            if (!verifiedThread) {
                threadsMeta[thread.threadNo].status = 'error';
            }

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
                        threadsMeta[thread.threadNo].summary = `ERROR: No spec files were found for thread #${threadId} [${shortThreadPath}]`;
                        str += `${err}\n`;
                        exitCode = 1;
                        threadSummary.nospecs++;
                    } else if (threadsMeta[thread.threadNo].errorType === 'critical') {
                        const err = 'CRITICAL ERROR: Thread did not complete!';
                        threadsMeta[thread.threadNo].status = 'error';
                        threadsMeta[thread.threadNo].heading.push(err);
                        str += `${err}\n`;
                        exitCode = 1;
                        threadSummary.criticals++;
                    } else if (threadsMeta[thread.threadNo].errorType === 'timeout') {
                        const err = `CRITICAL ERROR: Thread did not complete as it went over the time limit of ${secondsToNaturalString(threadTimeLimit)}`;
                        threadsMeta[thread.threadNo].status = 'error';
                        threadsMeta[thread.threadNo].heading.push(err);
                        str += `${err}\n`;
                        exitCode = 1;
                        threadSummary.timeouts++;
                    }

                    const percentageOfTotal = (
                        threadsMeta[thread.threadNo].perfResults.secs / timeOfLongestThread
                    ) * 100;

                    if (isNaN(percentageOfTotal)) {
                        str += '\n';
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

                                if (threadSummary.fails[num]) {
                                    threadSummary.fails[num] += counts[num];
                                } else {
                                    threadSummary.fails[num] = counts[num];
                                }
                            });
                        }

                        if (threadsMeta[thread.threadNo].retries) {
                            if (threadSummary.crashes[threadsMeta[thread.threadNo].retries]) {
                                threadSummary.crashes[threadsMeta[thread.threadNo].retries]++;
                            } else {
                                threadSummary.crashes[threadsMeta[thread.threadNo].retries] = 1;
                            }

                            if (threadsMeta[thread.threadNo].retries === maxThreadRestarts) {
                                result.push(`the thread crashed ${maxThreadRestarts} time${maxThreadRestarts === 1 ? '' : 's'}, never recovering`);
                            } else {
                                if (threadsMeta[thread.threadNo].status !== 'error') threadsMeta[thread.threadNo].status = 'warn';

                                result.push(`the thread needed restarting ${threadsMeta[thread.threadNo].retries} time${threadsMeta[thread.threadNo].retries === 1 ? '' : 's'}`);
                            }
                        }

                        if (!result.length) {
                            if (threadsMeta[thread.threadNo].status === 'success' || threadsMeta[thread.threadNo].errorType) {
                                return '';
                            }

                            threadSummary.unknowns++;
                            result.push('Test results are missing!')
                        }

                        threadsMeta[thread.threadNo].heading.push(`WARNING: ${arrToNaturalStr(result)}`);
                        threadsMeta[thread.threadNo].summary = `WARNING: Thread #${threadId} [${shortThreadPath}]: ${arrToNaturalStr(result)}`;

                        return ` (WARNING: ${arrToNaturalStr(result)})`;
                    };

                    str += `${generatePercentageBar(percentageOfTotal, threadsMeta[thread.threadNo].perfResults.secs)}${reportFailedTests(threadsMeta[thread.threadNo].perfResults.failedTests)}\n\n`;
                });
            });

            return str;
        };

        reportText = `See below to compare how each thread performed.\n\n${generateThreadBars(longestThread.secs)}The percentages given above represent how much time individual threads took to complete relative to thread #${longestThread.threadNo}, which was the longest at ${longestThread.naturalString}. Any thread that takes significantly longer than others will be a bottleneck, so the closer the percentages are to one another, the better. A wide range in percentages indicates that the threads could be balanced more efficiently. Be alert as to whether any thread/test needed retrying, because that will skew the results for the affected threads.`;

        threadSummary.summary = (() => {
            if (threadSummary.criticals) {
                threadSummary.criticalsArr.push(`${threadSummary.criticals} thread${threadSummary.criticals === 1 ? '' : 's'} didn\'t complete due to critical errors`);
            }

            if (threadSummary.timeouts) {
                threadSummary.criticalsArr.push(`${threadSummary.timeouts} thread${threadSummary.timeouts === 1 ? '' : 's'} didn\'t complete due to timing out`);
            }

            Object.entries(threadSummary.crashes).reverse().forEach((prop) => {
                threadSummary.crashSummary.push(`${prop[1]} thread${prop[1] === 1 ? '' : 's'} crashed ${prop[0]} time${Number(prop[0]) === 1 ? '' : 's'}`);
            });

            Object.entries(threadSummary.fails).reverse().forEach((prop) => {
                threadSummary.failSummary.push(`${prop[1]} test${prop[1] === 1 ? '' : 's'} failed ${prop[0]} time${Number(prop[0]) === 1 ? '' : 's'}`);
            });

            const summary = [
                threadSummary.nospecs ? `${threadSummary.nospecs} thread${threadSummary.nospecs === 1 ? '' : 's'} didn't contain any spec files` : null,
                threadSummary.unknowns ? `Test results are missing from ${threadSummary.unknowns} thread${threadSummary.unknowns === 1 ? '' : 's'}` : null,
                arrToNaturalStr(threadSummary.criticalsArr),
                arrToNaturalStr(threadSummary.crashSummary),
                arrToNaturalStr(threadSummary.failSummary)
            ].filter(s => s).join('. ')

            return summary ? summary : 'No tests failed!';
        })();

        console.log(`\n\n${threadSummary.summary}`);

        fs.writeFileSync(path.resolve(reportDir, 'thread-performance-summary.txt'), threadSummary.summary);

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
    async function allureGenerate() {
        process.stdout.write('Generating report...');

        // TODO remove bug workaround; shouldn't need to reference exact filepath
        // see https://github.com/allure-framework/allure-npm/issues/30
        const allureExecFilepath = path.resolve(
            path.dirname(require.resolve('allure-commandline')),
            'dist',
            'bin',
            `allure${process.platform.startsWith('win') ? '.bat' : ''}`
        );

        const testy = spawn('bash', [
            path.resolve(__dirname, 'shell', 'allure.sh'),
            reportDir,
            allureExecFilepath,
            !!combineAllure,
        ]);

        return new Promise((resolve) => {
            testy.on('close', () => {
                process.stdout.write(' done\n');
                resolve();
            });
        });
    }

    await allureGenerate();

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

    const criticalErrorThreads = Object.entries(threadsMeta).filter(o => o[1].errorType === 'critical').map(o => o[0]);
    const timeoutErrorThreads = Object.entries(threadsMeta).filter(o => o[1].errorType === 'timeout').map(o => o[0]);

    const minorErrorThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'error').filter(o => !['critical', 'timeout'].includes(o[1].errorType)).map(o => o[0]);
    const allErrorThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'error').map(o => o[0]);
    const warnThreads = Object.entries(threadsMeta).filter(o => o[1].status === 'warn').map(o => o[0]);

    const allErrorThreadPaths = allErrorThreads.map(threadNo => threadsMeta[threadNo].path);

    benchmarkObj.note = fullConfig.benchmarkNote;
    benchmarkObj.order = [...new Set(Object.values(threadsMeta).filter(thread => thread.perfResults.secs).sort((a, b) => b.perfResults.secs - a.perfResults.secs).map(threadsMeta => threadsMeta.path))];
    benchmarkObj.fails = allErrorThreadPaths;
    benchmarkObj.timestamp = timestamp;

    let compareBenchmarks = true;

    if (benchmarkObj.order.length < 2) {
        if (saveThreadBenchmark) {
            console.log(orange('The thread order in the benchmark file won\'t be updated because two or more threads with different files are required to determine the optimal order!'));
        }

        if (savedThreadBenchmark[benchmarkId]?.order) {
            benchmarkObj.order = savedThreadBenchmark[benchmarkId].order;
            compareBenchmarks = false;
        }
    } else if (phaseLock < fullConfig.phases.length) {
        if (saveThreadBenchmark) {
            console.log(orange('The thread order in the benchmark file won\'t be updated because one or more phases did not complete!'));
        }

        if (savedThreadBenchmark[benchmarkId]?.order) {
            benchmarkObj.order = savedThreadBenchmark[benchmarkId].order;
            compareBenchmarks = false;
        }
    }

    if (saveThreadBenchmark) {
        if (compareBenchmarks) {
            if (JSON.stringify(savedThreadBenchmark[benchmarkId]?.order) !== JSON.stringify(benchmarkObj.order)) {
                console.log(`Updating thread order:\n["${benchmarkObj.order.join('", "')}"]`);
            } else {
                console.log('The results of the thread benchmark are identical to the records already saved; the thread order doesn\'t need changing!');
            }
        }

        fs.writeFileSync(threadBenchmarkFilepath, `${JSON.stringify({
            ...savedThreadBenchmark,
            [benchmarkId]: benchmarkObj,
        }, null, 4)}\n`);

        console.log(`Benchmark file updated: ${threadBenchmarkFilepath}`);
    }

    let browserStackObservabilityURL;

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

                const bsoUploadResp = runShellCommand(
                    `curl -u "${browserStackObservability.username}:${browserStackObservability.accessKey}" -X POST -F "data=@${path.basename(outputFileBSO)}" ${Object.keys(browserStackObservability.parameters || {}).map(key => `-F "${key}=${browserStackObservability.parameters[key]}"`).join(' ')} ${endpoint}`,
                    path.dirname(outputFileBSO),
                    true
                )

                const bsoUploadMessage = JSON.parse(bsoUploadResp || {}).message || '';

                if (bsoUploadMessage.includes('https://')) {
                    browserStackObservabilityURL = bsoUploadMessage.substring(bsoUploadMessage.indexOf('https://'));
                }

                fs.writeFileSync(
                    path.resolve(defaultAllureReportDir, 'browserstack_test_observability_report.html'),
                    `<!DOCTYPE html>
<html lang="en">

<head>
    <title>BrowserStack Test Observability report</title>
    <meta http-equiv="refresh" content="0; url=${browserStackObservabilityURL}">
</head>

<body>
    <p>Redirecting...</p>
</body>

</html>`
                );

                console.log(`\n\nUploaded JUnit report to ${endpoint}\n`);
            } catch (err) {
                console.error(red(`ERROR: JUnit report failed to upload to ${endpoint}:`), err);
            }
        }
    }

    const updatedAllureHistoryPath = path.resolve(defaultAllureReportDir, 'history');

    if (fs.existsSync(updatedAllureHistoryPath)) {
        getFiles(updatedAllureHistoryPath).forEach((file) => {
            if (file.endsWith('.json')) {
                try {
                    fs.writeFileSync(file, `${JSON.stringify(JSON.parse(
                        fs.readFileSync(file).toString('utf8')
                    ), null, 4)}\n`);
                } catch (err) {
                    console.warn(orange(`WARNING: Failed to parse Allure history file "${file}"`));
                }
            }
        });

        if (overwriteAllureHistory && allureHistoryDir) {
            fs.copySync(
                updatedAllureHistoryPath,
                allureHistoryDir,
                { overwrite: true },
            )
        }
    }

    customLogs.forEach((customLog, index) => {
        if (typeof customLog.generateContent === 'function') {
            if (customLog.content) {
                customLog.content += `\n\n${customLog.generateContent()}`;
            } else {
                customLog.content = customLog.generateContent();
            }
        }

        if (!customLog.heading) {
            customLog.heading = `Custom Logs ${index + 1}`;
        }

        console.log(`${customLog.heading}\n\n${customLog.content}`);
    });

    if (generateAllure) {
        const defaultAllureReportHtml = path.resolve(defaultAllureReportDir, 'index.html');
        const defaultAllureReportHtmlComplete = path.resolve(defaultAllureReportDir, 'complete.html');

        const allureReportHtml = path.resolve(allureReportDir, 'index.html');
        const allureReportHtmlComplete = path.resolve(allureReportDir, 'complete.html');

        if (fs.existsSync(defaultAllureReportHtml)) {
            let allLogs = '';

            customLogs.forEach((customLog) => {
                allLogs += `<div class="cmr-thread cmr-custom">
                    <span class="cmr-pre-heading cmr-sticky">
                        <h2 id="cmr-arr-content">➡️</h2>
                        <h2>${customLog.heading}</h2>
                    </span>
                    <div id="cmr-pre-content" style="display:none;overflow:auto;margin-top:20px;">
                    <div class="cmr-thread-pre"><pre>${customLog.content}</pre></div>
                    </div>
                </div>`;
            });

            Object.keys(threadsMeta).forEach((threadNo) => {
                if (!threadsMeta[threadNo].logs) {
                    return;
                }

                allLogs += `
                <div class="cmr-thread cmr-${threadsMeta[threadNo].status}">
                    <span class="cmr-pre-heading cmr-sticky">
                        <h2 id="cmr-arr-content">➡️</h2>
                        <h2>${threadsMeta[threadNo].heading.join('<br>')}</h2>
                    </span>
                    <div id="cmr-pre-content" style="display:none;overflow:auto;margin-top:20px;">
                    ${threadsMeta[threadNo].logsTimestamped.map(logs => {
                    return `<div class="cmr-thread-pre">
                        <pre>${logs[0]}</pre>
                        <div class="cmr-thread-log-divide"></div>
                        <pre>${logs[1].replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
                        </div>`
                }).join('')}
                    </div>
                </div>`;
            });

            const status = (() => {
                if (allErrorThreads.length) return 'error';
                if (warnThreads.length) return 'warn';
                return 'success';
            })();

            let printedHeaderMsg = false;

            const printHeaderMsg = (msg) => {
                if (printedHeaderMsg) return msg;

                printedHeaderMsg = true;

                return `${browserStackObservabilityURL ? `<strong>View the BrowserStack Test Observability report here: <a href="${browserStackObservabilityURL}">${browserStackObservabilityURL}</a></strong><br><br>` : ''}${msg}`;
            }

            const cmrAllureBody = `<body>
                <div class="cmr-hidden">
                <script type="application/json" id="cmr-run-config">${JSON.stringify({
                browserStackObservabilityURL,
                summary: threadSummary.summary,
                ...benchmarkObj,
            }, null, 4)}</script>
                </div>
                <div class="cmr-content cmr-header">
                    <div class="cmr-${status} cmr-headline"><h2 id="cmr-collapse">⬇️</h2><h2>${allureReportHeading}${(criticalErrorThreads.length || timeoutErrorThreads.length) ? ' [CRITICAL ERRORS - PLEASE READ]' : ''}</h2></div>
                    ${(criticalErrorThreads.length || timeoutErrorThreads.length) ? `
                    <div class="cmr-error cmr-summary">
                        ${printHeaderMsg((() => {
                let str = 'Be advised! This Allure report doesn\'t tell the full story.'

                if (threadTimeoutCount > maxAllowedTimeouts) {
                    str += ` ${threadTimeoutCount} thread${threadTimeoutCount === 1 ? '' : 's'} timed out, which is more than the allowed limit. When this limit was surpassed, all incomplete threads stopped running immediately.<br><br>`
                }

                if (phaseLock < fullConfig.phases.length) {
                    str += ` One or more tests in <strong>phase #${phaseLock} failed</strong>, therefore any tests from threads in subsequent phases did not complete. They'll all be marked as having critical errors.<br><br>`
                }

                if (criticalErrorThreads.length) {
                    str += ` <strong>Thread ${arrToNaturalStr(criticalErrorThreads.map(num => `#${num}`))} had ${criticalErrorThreads.length > 1 ? 'critical errors' : 'a critical error'}</strong> and didn't complete!`;
                }

                if (timeoutErrorThreads.length) {
                    str += ` <strong>Thread ${arrToNaturalStr(timeoutErrorThreads.map(num => `#${num}`))} ${timeoutErrorThreads.length > 1 ? 'were' : 'was'} stopped early</strong> because ${timeoutErrorThreads.length > 1 ? 'they each' : 'it'} failed to complete within the maximum time limit of ${secondsToNaturalString(threadTimeLimit)}.`
                }

                return `${str} Therefore, one or more spec files may have not been fully tested!`;
            })())}
                    </div>` : ''}
                    ${minorErrorThreads.length ? `
                    <div class="cmr-error cmr-summary">
                        ${printHeaderMsg(minorErrorThreads.map(threadNo => threadsMeta[threadNo].summary).join('<br>'))}
                    </div>` : ''}
                    ${warnThreads.length ? `
                    <div class="cmr-warn cmr-summary">
                        ${printHeaderMsg(warnThreads.map(threadNo => threadsMeta[threadNo].summary).join('<br>'))}
                    </div>` : ''}
                    ${status === 'success' ? `
                    <div class="cmr-success cmr-summary">
                        ${printHeaderMsg('Everything seems completely fine! No tests needed retrying.')}
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
                }<div class="cmr-report"><button id="cmr-open-all">Open all logs above</button><button id="cmr-close-all">Close all logs above</button><br><br><h2 class="cmr-sticky">Thread Performance Summary</h2><pre>${[threadSummary.summary, reportText].filter(s => s).join('\n\n')}</pre></div></div>
                
                    <style>
                    .cmr-content {
                        overflow-wrap: anywhere;
                        outline: 2px solid #343434;
                    }

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

                    .cmr-thread-log-divide {
                        padding: 0!important;
                        min-width: 1px!important;
                        background: grey!important;
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
                    }

                    .cmr-content > * {
                        outline: 1px solid #343434;
                    }

                    .cmr-hidden {
                        display: none;
                    }

                    .cmr-thread-pre {
                        display: flex;
                        padding: 0!important;
                        gap: 20px;
                    }

                    .cmr-thread-pre pre {
                        margin: 0;
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

                    .cmr-content div.cmr-custom {
                        background:rgb(88, 169, 250);
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
                        const thisIndex = index;
                
                        heading.addEventListener('click', (e) => {
                          const topTarget=e.target.getBoundingClientRect().top;                            
                          heading.classList.toggle('cmr-pre-heading-active');

                          const thisPre = document.querySelectorAll('#cmr-pre-content')[thisIndex];
                          const thisArr = document.querySelectorAll('#cmr-arr-content')[thisIndex];
                    
                          if (thisPre.style.display === 'none') {
                            thisPre.style.removeProperty('display');
                            thisArr.innerHTML = '⬇️';
                          } else {
                            thisPre.style.display = 'none';
                            thisArr.innerHTML = '➡️';

                            window.scrollTo(0,0);
                            const currentTop=e.target.getBoundingClientRect().top;
                            window.scrollBy(0,currentTop-topTarget);
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

            let combinedAllureSuccessfully = false;

            if (combineAllure) {
                try {
                    fs.moveSync(
                        path.resolve(reportDir, 'allure-report-temp', 'index.html'),
                        path.resolve(defaultAllureReportDir, 'complete.html'),
                        { overwrite: true },
                    );

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
                    console.log = defaultLog;

                    console.log(red('Error when attempting to bundle the Allure report into a single file!'));
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

            console.log(green(`The Allure report for this run has been saved to the following directory: "${allureReportDir}"`));

            // host the Allure report as a localhost
            if (!fullConfig.maxConcurrentThreadsExperimentInProg) {
                if (hostAllure) {
                    runShellCommand('allure open', path.resolve(reportDir));
                } else if (openAllure) {
                    if (combinedAllureSuccessfully) {
                        runShellCommand(`open "${allureReportHtmlComplete}"`);
                    } else {
                        runShellCommand(`open "${allureReportHtml}"`);
                    }
                } else {
                    console.log('Passing through the arg --open will open the Allure report as soon as the tests have finished running')
                }
            }
        }
    }

    deleteEmptyFoldersRecursively(reportDir);

    if (fullConfig.waitForFileExist?.deleteAfterCompletion) {
        if (fs.existsSync(waitForFileExistFilepath)) {
            fs.unlinkSync(waitForFileExistFilepath);
        }
    }

    if (browserStackObservabilityURL) {
        console.log(green(`View the BrowserStack Test Observability report here: "${browserStackObservabilityURL}"`));
    }

    notify(exitCode === 0 ? 'Tests completed (all passed)' : 'Tests completed (with failures)');

    if (endProcessIfTestsFail && exitCode) {
        process.exit(exitCode);
    }

    return new Promise((resolve) => resolve(exitCode));
}
