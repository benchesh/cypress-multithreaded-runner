// The JUnit report, and uploading it to BrowserStack Test Observability. It's built from the same results as the
// Allure report rather than by Cypress, so it has every test: including those in threads that crashed, timed out or
// were stopped (which Cypress never reports), and those in spec files that weren't re-run

const fs = require('fs-extra');
const path = require('path');
const { red, orange, pluralise } = require('../util/format');

const DEFAULT_BSO_ENDPOINT = 'https://upload-observability.browserStack.com/upload';

// The latest result of a test is its final one, as in the Allure report. If two have the same timestamps, the better
// status wins (as with the timestamp nudge in lib/allure/results.js)
const STATUS_PRIORITY = { passed: 3, failed: 2, broken: 1 };

// characters that aren't allowed in XML 1.0, even escaped (control characters, unpaired surrogates etc.)
const INVALID_XML_CHARACTERS = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPES = /\u001b\[[\d;]*[A-Za-z]/g;

const clean = (value) => String(value ?? '').replace(ANSI_ESCAPES, '').replace(INVALID_XML_CHARACTERS, '');

const escapeText = (value) => clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const escapeAttribute = (value) => escapeText(value)
    .replace(/'/g, '&apos;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;')
    .replace(/\t/g, '&#9;');

const attributes = (values) => Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');

const seconds = (ms) => (Math.max(0, ms) / 1000).toFixed(3);

// e.g. "AssertionError" from "AssertionError: expected 1 to equal 2"
const errorType = (trace) => clean(trace).match(/^\s*((?:[A-Za-z_$][\w$]*)?(?:Error|Exception))\b/)?.[1];

const isLater = (result, than) => result.start > than.start
    || (result.start === than.start && (result.stop > than.stop
        || (result.stop === than.stop && (STATUS_PRIORITY[result.status] || 0) > (STATUS_PRIORITY[than.status] || 0))));

/**
 * The XML for one test
 *
 * @param {import('../allure/results').StoredResult} result
 */
const testCaseXml = (result) => {
    // the same name & classname as Cypress's own JUnit reporter, so services that track tests by them see the same tests
    const open = `    <testcase${attributes({
        name: result.fullTitle,
        classname: result.title,
        file: result.spec,
        time: seconds(result.stop - result.start),
    })}`;
    const details = attributes({ message: result.message, type: errorType(result.trace) });
    const body = escapeText(result.trace || result.message);

    switch (result.status) {
        case 'passed':
            return `${open} />`;
        case 'skipped':
            return `${open}>\n      <skipped${attributes({ message: result.message })} />\n    </testcase>`;
        case 'failed':
            return `${open}>\n      <failure${details}>${body}</failure>\n    </testcase>`;
        case 'broken':
            return `${open}>\n      <error${details}>${body}</error>\n    </testcase>`;
        default:
            return `${open}>\n      <error${attributes({ message: result.message || "The test's result is unknown" })}>${body}</error>\n    </testcase>`;
    }
};

const counts = (results) => ({
    tests: results.length,
    failures: results.filter((result) => result.status === 'failed').length,
    errors: results.filter((result) => !['passed', 'failed', 'skipped'].includes(result.status)).length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    time: seconds(results.reduce((total, result) => total + Math.max(0, result.stop - result.start), 0)),
});

/**
 * Build the JUnit report from the results that the Allure report is generated from, so that the two agree. Each test
 * is included once, with its final result. Its earlier results (e.g. from retryAllFailedSpecs) are left out, as the
 * Allure report shows them as retries
 *
 * @param {import('../allure/results').StoredResult[]} results
 * @returns {{xml: string, tests: number}}
 */
const buildJUnitReport = (results) => {
    /** spec => fullTitle => the latest result */
    const specs = new Map();

    results.forEach((result) => {
        if (!specs.has(result.spec)) {
            specs.set(result.spec, new Map());
        }

        const tests = specs.get(result.spec);
        const previous = tests.get(result.fullTitle);

        if (!previous || isLater(result, previous)) {
            tests.set(result.fullTitle, result);
        }
    });

    // results are collected in no particular order, so the spec files are sorted, and their tests are in the order they ran
    const suites = [...specs]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([spec, tests]) => ({ spec, results: [...tests.values()].sort((a, b) => a.start - b.start) }));
    const all = suites.flatMap((suite) => suite.results);

    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        `<testsuites${attributes({ name: 'Cypress Multithreaded Runner', ...counts(all) })}>`,
        ...suites.flatMap(({ spec, results: suiteResults }) => [
            `  <testsuite${attributes({ name: spec, file: spec, ...counts(suiteResults) })}>`,
            ...suiteResults.map(testCaseXml),
            '  </testsuite>',
        ]),
        '</testsuites>',
        '',
    ].join('\n');

    return { xml, tests: all.length };
};

/**
 * BrowserStack Test Observability doesn't like timestamps or certain characters in names
 */
const toBrowserStackXml = (xml) => xml
    .replace(/timestamp="(.*?)"( *|)/gmi, '')
    .replace(/name="([^"]+)"/g, (_match, nameValue) => `name="${nameValue.replace(/[^a-zA-Z0-9^ [\]:-_]/g, '-')}"`);

const redirectPage = (url) => `<!DOCTYPE html>
<html lang="en">

<head>
    <title>BrowserStack Test Observability report</title>
    <meta http-equiv="refresh" content="0; url=${url}">
</head>

<body>
    <p>Redirecting...</p>
</body>

</html>`;

const uploadToBrowserStack = async (xmlFile, options) => {
    const endpoint = options.endpoint || DEFAULT_BSO_ENDPOINT;
    const form = new FormData();

    form.append('data', new Blob([fs.readFileSync(xmlFile)]), path.basename(xmlFile));
    Object.entries(options.parameters || {}).forEach(([key, value]) => form.append(key, String(value)));

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${options.username}:${options.accessKey}`).toString('base64')}`,
        },
        body: form,
    });

    const text = await response.text().catch(() => '');
    let body = {};

    try {
        body = JSON.parse(text);
    } catch {
        // not JSON
    }

    const message = String(body.message || '');

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}${message || text ? `: ${message || text.slice(0, 500)}` : ''}`);
    }

    return {
        endpoint,
        url: message.includes('https://') ? message.substring(message.indexOf('https://')) : null,
    };
};

/**
 * Save the JUnit report, then upload it to BrowserStack if configured
 *
 * @param {object} options
 * @param {string} options.reportDir
 * @param {object} options.jUnitReport the jUnitReport setting
 * @param {import('../allure/results').StoredResult[]} options.results every result in the Allure results directory
 * @param {string} options.allureReportDir the redirect page to the BrowserStack report is saved here
 * @returns {Promise<string|null>} the BrowserStack Test Observability URL, if uploaded
 */
const processJUnitReports = async ({ reportDir, jUnitReport, results, allureReportDir }) => {
    const outputFile = path.join(reportDir, 'combined-junit-report.xml');
    const bso = jUnitReport.browserStackTestObservabilityUpload;
    let tests;

    try {
        const report = buildJUnitReport(results);

        tests = report.tests;
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(outputFile, report.xml);
    } catch (err) {
        console.error(red('ERROR: The JUnit report couldn\'t be saved:'), err);
        return null;
    }

    if (!tests) {
        console.warn(orange(`WARNING: There were no test results, so the JUnit report is empty${bso ? ' and hasn\'t been uploaded to BrowserStack Test Observability' : ''}. If tests did run, check that the Allure writer is set up in your Cypress config file (see the README).`));
        return null;
    }

    if (!bso) {
        return null;
    }

    const bsoFile = outputFile.replace(/\.xml$/, '-bso.xml');

    try {
        fs.writeFileSync(bsoFile, toBrowserStackXml(fs.readFileSync(outputFile, 'utf8')));

        const { endpoint, url } = await uploadToBrowserStack(bsoFile, bso);

        if (url) {
            fs.mkdirSync(allureReportDir, { recursive: true });
            fs.writeFileSync(path.resolve(allureReportDir, 'browserstack_test_observability_report.html'), redirectPage(url));
        }

        console.log(`\n\nUploaded the JUnit report (${pluralise(tests, 'test')}) to ${endpoint}\n`);

        return url;
    } catch (err) {
        console.error(red(`ERROR: The JUnit report failed to upload to ${bso.endpoint || DEFAULT_BSO_ENDPOINT}:`), err);
        return null;
    }
};

module.exports = {
    processJUnitReports,
    buildJUnitReport,
    toBrowserStackXml,
};
