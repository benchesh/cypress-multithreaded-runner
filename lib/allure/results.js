// Reading, normalising and writing Allure result files

const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { getFiles, writeJsonSyncRecursive, toPosixRelative } = require('../util/fs');
const { containsCrashPattern } = require('../cypress/logAnalysis');

const RESULT_FILE_SUFFIX = '-result.json';

/**
 * The full Mocha title of the test an Allure result belongs to. allure-cypress prefixes its fullName
 * with "<package>:<spec path>#", which is stripped; @mmisty/cypress-allure-adapter uses the title as-is
 */
const resultFullTitle = (result) => {
    const { fullName, name, labels = [] } = result;

    if (fullName && Array.isArray(result.titlePath) && fullName.includes('#')) {
        return fullName.slice(fullName.indexOf('#') + 1);
    }

    if (fullName) {
        return fullName;
    }

    const suites = ['parentSuite', 'suite', 'subSuite']
        .map((labelName) => labels.find((label) => label.name === labelName)?.value)
        .filter(Boolean);

    return [...suites, name].filter(Boolean).join(' ');
};

/**
 * A stable id for a test, used by Allure to group retries and track history. It's derived from the spec
 * path and the test's full title only, as some adapters add labels that change on every run
 * (e.g. allure-cypress's `thread` label contains a process id)
 */
const testHistoryId = (specRelativePath, fullTitle) => crypto.createHash('md5').update(`${specRelativePath}#${fullTitle}`).digest('hex');

// Workaround for a bug whereby a test may display as failed if its timestamps are identical to the run that passed
const TIMESTAMP_NUDGE = { passed: 3, failed: 2, broken: 1 };

/**
 * @typedef {object} CollectedResult
 * @property {number} attempt which attempt of the thread produced the result (see retryAllFailedSpecs)
 * @property {string} fullTitle
 * @property {string} status passed, failed, broken, skipped or unknown
 * @property {number} start
 */

class AllureResultsStore {
    /**
     * @param {object} options
     * @param {string} options.allureResultsDir the directory the Allure report is generated from
     * @param {string} [options.cwd] spec paths in history ids are relative to this
     */
    constructor({ allureResultsDir, cwd = process.cwd() }) {
        this.allureResultsDir = allureResultsDir;
        this.cwd = cwd;
    }

    /**
     * Each thread writes to its own directory. The `_fallback` directory is used by the allure-cypress
     * fallback reporter (see allure/writer.js)
     */
    threadDirs(thread) {
        return {
            main: path.join(this.allureResultsDir, String(thread.threadNo)),
            fallback: path.join(this.allureResultsDir, `${thread.threadNo}_fallback`),
        };
    }

    /**
     * Results from the main reporter are used unless it produced nothing, in which case the fallback's are used
     */
    chooseDir(thread) {
        const { main, fallback } = this.threadDirs(thread);

        return getFiles(main).length || !fs.existsSync(fallback) ? main : fallback;
    }

    /**
     * The first of the thread's result files to contain the messages Cypress prints when it crashes, if any
     *
     * @returns {string|null} the path of the file
     */
    findCrashLogs(thread) {
        return Object.values(this.threadDirs(thread))
            .flatMap((dir) => getFiles(dir))
            .filter((file) => file.endsWith('.json'))
            .find((file) => {
                try {
                    return containsCrashPattern(fs.readFileSync(file, 'utf8'));
                } catch (err) {
                    return false;
                }
            }) || null;
    }

    clear(thread) {
        Object.values(this.threadDirs(thread)).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
    }

    specRelativePath(spec) {
        return toPosixRelative(spec, this.cwd);
    }

    /**
     * Move a thread's result files into the main results directory (all files must be in the same directory
     * to generate the Allure report), normalising each result and recording it on the thread
     */
    collect(thread) {
        const dir = this.chooseDir(thread);
        const specPath = this.specRelativePath(thread.spec);

        getFiles(dir).forEach((file) => {
            const destination = path.join(this.allureResultsDir, path.basename(file));

            if (!file.endsWith(RESULT_FILE_SUFFIX)) {
                fs.moveSync(file, destination, { overwrite: true });
                return;
            }

            let result;

            try {
                result = fs.readJsonSync(file);
            } catch (err) {
                fs.moveSync(file, destination, { overwrite: true });
                return;
            }

            const fullTitle = resultFullTitle(result);

            result.historyId = testHistoryId(specPath, fullTitle);

            const nudge = TIMESTAMP_NUDGE[result.status] || 0;
            if (typeof result.start === 'number') result.start += nudge;
            if (typeof result.stop === 'number') result.stop += nudge;

            writeJsonSyncRecursive(destination, result);
            fs.rmSync(file);

            thread.hasResults = true;
            thread.results.push({
                attempt: thread.attempts,
                fullTitle,
                status: result.status || 'unknown',
                start: result.start || 0,
            });
        });

        this.clear(thread);
    }

    /**
     * Write a result for a test that didn't produce one itself
     */
    writeSyntheticResult({ spec, test, status, message, time = Date.now() }) {
        const specPath = this.specRelativePath(spec);
        const uuid = crypto.randomUUID();
        const [parentSuite, suite, subSuite] = test.titlePath;

        const labels = [
            { name: 'package', value: specPath.split('/').join('.') },
            { name: 'path', value: specPath },
            parentSuite !== undefined ? { name: 'parentSuite', value: parentSuite } : null,
            suite !== undefined ? { name: 'suite', value: suite } : null,
            subSuite !== undefined ? { name: 'subSuite', value: subSuite } : null,
            ...test.tags.map((tag) => ({ name: 'tag', value: tag })),
        ].filter(Boolean);

        const result = {
            uuid,
            historyId: testHistoryId(specPath, test.fullTitle),
            name: test.title,
            fullName: test.fullTitle,
            status,
            statusDetails: { message },
            stage: 'finished',
            steps: [],
            attachments: [],
            parameters: [],
            labels,
            links: [],
            start: time,
            stop: time,
        };

        writeJsonSyncRecursive(path.join(this.allureResultsDir, `${uuid}${RESULT_FILE_SUFFIX}`), result);

        return result;
    }
}

module.exports = {
    AllureResultsStore,
    resultFullTitle,
    testHistoryId,
};
