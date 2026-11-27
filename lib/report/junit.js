// Combining the per-thread JUnit reports and uploading them to BrowserStack Test Observability

const fs = require('fs-extra');
const path = require('path');
const { red } = require('../util/format');

const DEFAULT_BSO_ENDPOINT = 'https://upload-observability.browserStack.com/upload';

const jUnitDir = (reportDir) => path.join(reportDir, 'junit');

/**
 * The XML file a thread's JUnit report is written to
 */
const threadJUnitFile = (reportDir, thread) => path.join(
    jUnitDir(reportDir),
    `${thread.threadNo}${thread.attempts > 1 ? `_attempt${thread.attempts}` : ''}.xml`,
);

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

    const body = await response.json().catch(() => ({}));
    const message = body.message || '';

    return {
        endpoint,
        url: message.includes('https://') ? message.substring(message.indexOf('https://')) : null,
    };
};

/**
 * Merge every thread's JUnit report into one, then upload it to BrowserStack if configured
 *
 * @param {object} options
 * @param {string} options.reportDir
 * @param {object} options.jUnitReport the jUnitReport setting
 * @param {string} options.allureReportDir the redirect page to the BrowserStack report is saved here
 * @returns {Promise<string|null>} the BrowserStack Test Observability URL, if uploaded
 */
const processJUnitReports = async ({ reportDir, jUnitReport, allureReportDir }) => {
    const { mergeFiles } = require('junit-report-merger');
    const outputFile = path.join(reportDir, 'combined-junit-report.xml');

    try {
        await mergeFiles(outputFile, [path.join(jUnitDir(reportDir), '*.xml')]);

        // remove a dodgy tag that breaks the report
        fs.writeFileSync(outputFile, fs.readFileSync(outputFile, 'utf8').replace(/<\/>/gm, ''));
    } catch (err) {
        console.error(red('ERROR: JUnit report merge failed:'), err);
        return null;
    }

    const bso = jUnitReport.browserStackTestObservabilityUpload;

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

        console.log(`\n\nUploaded JUnit report to ${endpoint}\n`);

        return url;
    } catch (err) {
        console.error(red(`ERROR: JUnit report failed to upload to ${bso.endpoint || DEFAULT_BSO_ENDPOINT}:`), err);
        return null;
    }
};

module.exports = {
    processJUnitReports,
    threadJUnitFile,
    toBrowserStackXml,
};
