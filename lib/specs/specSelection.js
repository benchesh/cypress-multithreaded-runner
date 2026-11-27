// Works out which spec files the user wants to run: either an explicit `specFiles` list, or the
// spec files that failed in a previous run (from a report URL/path, a reports directory or an object)

const fs = require('fs-extra');
const path = require('path');
const { parse } = require('node-html-parser');
const { getFilesRecursive } = require('../util/fs');
const { green, pluralise } = require('../util/format');

/**
 * @typedef {object} SpecSelection
 * @property {string[]|null} specFiles only these spec files should run (null = run everything)
 * @property {boolean} assumeOthersPassed spec files that aren't run should be treated as passed,
 * because they're only being skipped as they passed in a previous run
 * @property {string|null} source a human readable description of where the list came from
 */

/**
 * Depth-first search for the first array under a `fails` key
 */
const findFailsArray = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    if (Array.isArray(value.fails)) {
        return value.fails;
    }

    for (const child of Object.values(value)) {
        const found = findFailsArray(child);

        if (found) {
            return found;
        }
    }

    return null;
};

/**
 * Extract the failed spec files from a runner report: either an Allure report HTML file
 * (which embeds the run config in #cmr-run-config) or a cmr-summary.json file
 *
 * @returns {string[]|null} null if the content couldn't be parsed
 */
const parseFailsFromReport = (content) => {
    try {
        const trimmed = content.trim();

        if (trimmed.startsWith('{')) {
            return findFailsArray(JSON.parse(trimmed));
        }

        const configEl = parse(content).querySelector('#cmr-run-config');

        if (!configEl) {
            return null;
        }

        return findFailsArray(JSON.parse(configEl.textContent.replace(/\n/g, '')));
    } catch (err) {
        return null;
    }
};

const describeFails = (fails, sourceLabel) => {
    const str = `${pluralise(fails.length, 'failed spec file')} ${fails.length === 1 ? 'was' : 'were'} found in ${sourceLabel}${fails.length ? `:\n${fails.join('\n')}\n` : ''}`;

    return fails.length ? green(str) : str;
};

const fromObject = (value, log) => {
    let obj = value;

    // Via the CLI the value arrives as a string, so try to parse it as JSON
    if (typeof obj === 'string') {
        try {
            obj = JSON.parse(obj);
        } catch (err) {
            throw new Error('runFailedSpecFilesFromObject must be an array or a valid JSON object/string');
        }
    }

    const fails = Array.isArray(obj) ? obj : findFailsArray(obj);

    if (!fails) {
        throw new Error('No "fails" array was found in runFailedSpecFilesFromObject');
    }

    if (!fails.length) {
        throw new Error('No failed spec files were found in runFailedSpecFilesFromObject');
    }

    log(describeFails(fails, 'runFailedSpecFilesFromObject'));

    return fails;
};

const fromReportsDir = (reportsDir, log) => {
    const dir = path.resolve(reportsDir);

    if (!fs.existsSync(dir)) {
        throw new Error(`Directory "${dir}" doesn't exist`);
    }

    const reportFilesNewestFirst = getFilesRecursive(dir)
        .filter((file) => file.endsWith('.html') || path.basename(file) === 'cmr-summary.json')
        .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime);

    if (!reportFilesNewestFirst.length) {
        throw new Error(`No HTML files were found in "${reportsDir}"`);
    }

    for (const file of reportFilesNewestFirst) {
        const fails = parseFailsFromReport(fs.readFileSync(file, 'utf8'));

        if (fails?.length) {
            log(describeFails(fails, `the report "${file}"`));
            return { fails, source: file };
        }
    }

    throw new Error(`No failed spec files were found in any reports within "${reportsDir}"`);
};

const fromReportUrl = async (urlOrPath, log, fetchText) => {
    const localPath = path.resolve(urlOrPath);

    const content = fs.existsSync(localPath)
        ? fs.readFileSync(localPath, 'utf8')
        : await fetchText(urlOrPath);

    const fails = parseFailsFromReport(content);

    if (!fails) {
        throw new Error(`Failed to parse the report "${urlOrPath}"`);
    }

    log(describeFails(fails, `the report "${urlOrPath}"`));

    if (!fails.length) {
        throw new Error(`No failed spec files were found in the report "${urlOrPath}"`);
    }

    return fails;
};

const defaultFetchText = async (url) => {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to fetch "${url}" (HTTP ${response.status})`);
    }

    return response.text();
};

/**
 * @param {object} settings normalised settings
 * @param {object} [deps]
 * @param {(msg: string) => void} [deps.log]
 * @param {(url: string) => Promise<string>} [deps.fetchText]
 * @returns {Promise<SpecSelection>}
 */
const resolveSpecSelection = async (settings, { log = console.log, fetchText = defaultFetchText } = {}) => {
    if (settings.runFailedSpecFilesFromObject) {
        log('');

        return {
            specFiles: fromObject(settings.runFailedSpecFilesFromObject, log),
            assumeOthersPassed: true,
            source: 'runFailedSpecFilesFromObject',
        };
    }

    if (settings.runMostRecentlyFailedSpecFilesFromReportsDir) {
        log('');

        const { fails, source } = fromReportsDir(settings.runMostRecentlyFailedSpecFilesFromReportsDir, log);

        return { specFiles: fails, assumeOthersPassed: true, source: `the report "${source}"` };
    }

    if (settings.runFailedSpecFilesFromReportURL) {
        log('');

        return {
            specFiles: await fromReportUrl(settings.runFailedSpecFilesFromReportURL, log, fetchText),
            assumeOthersPassed: true,
            source: `the report "${settings.runFailedSpecFilesFromReportURL}"`,
        };
    }

    return { specFiles: settings.specFiles, assumeOthersPassed: false, source: null };
};

module.exports = {
    resolveSpecSelection,
    findFailsArray,
    parseFailsFromReport,
};
