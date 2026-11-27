// The custom header and footer injected into the Allure report: a summary of the run, every thread's
// logs, the thread performance summary, and an embedded copy of the run config (used by
// runFailedSpecFilesFromReportURL & runMostRecentlyFailedSpecFilesFromReportsDir)

const fs = require('fs-extra');
const path = require('path');
const { escapeHtml } = require('../../util/format');

const STYLES = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const CLIENT_SCRIPT = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const SNAPDOM_URL = 'https://unpkg.com/@zumer/snapdom/dist/snapdom.js';
const SCREENSHOT_TEXT = 'Take screenshot &#128247;';

// stop "</script>" inside the JSON from closing the script tag early
const jsonForScript = (obj) => JSON.stringify(obj, null, 4).replace(/</g, '\\u003c');

const screenshotModal = (title) => `<div style="position: fixed; width: 100vw; height: 100vh; background: rgba(0, 0, 0, 0.7); padding: min(100px, 10%); z-index: 100; margin: 0px auto; display: none;" id="cmr-screenshot-modal"><div style="background: black; width: 100%; height: 100%; box-shadow: 0 0 64px rgba(0,0,0,1); position: relative;">
    <button style="color: white; position: absolute; filter: drop-shadow(0 0 10px black); padding: 10px; background: rgba(0,0,0,0.7); right: 0; font-size: 16px; top: 70px; border: 0; text-align: left;" id="cmr-download">Download &#128190;</button>
    <button style="color: white; position: absolute; filter: drop-shadow(0 0 10px black); padding: 10px; background: rgba(0,0,0,0.7); right: 0; font-size: 16px; top: 109px; border: 0; text-align: left;" id="cmr-copy-to-clipboard">Copy to clipboard &#128203;<span id="cmr-copied-to-clipboard" style="color: lawngreen; display: none;">Copied!</span></button>
    <button style="color: white; padding: 0 10px; right: 0; border: 0; font-size: 60px; background: rgba(0,0,0,0.7); position: absolute; filter: drop-shadow(0 0 10px black);" id="cmr-screenshot-modal-close">X</button>
    <img id="cmr-screenshot-output" title="${escapeHtml(title)}" style="width: 100%; height: 100%; object-fit: contain;">
</div></div>`;

const summaryBlock = (className, html) => (html ? `
    <div class="cmr-${className} cmr-summary cmr-hidden">
        ${html}
    </div>` : '');

/**
 * @param {object} options
 * @param {string} options.heading e.g. "Cypress Multithreaded Runner: My heading"
 * @param {'success'|'warn'|'error'} options.status
 * @param {object} options.runConfig embedded as JSON
 * @param {string|null} options.criticalHtml shown when threads didn't complete
 * @param {string[]} options.errors per-thread error summaries
 * @param {string[]} options.warnings per-thread warning summaries
 * @param {string[]} options.notes
 * @param {string|null} options.browserStackObservabilityURL
 * @param {number} options.timestamp
 */
const buildReportHeader = ({ heading, status, runConfig, criticalHtml, errors, warnings, notes, browserStackObservabilityURL, timestamp }) => {
    const headingHtml = escapeHtml(heading).replace('Cypress Multithreaded Runner:', '<span style="font-size:9pt;position:absolute;top:0;opacity:0.8;">Cypress Multithreaded Runner:</span>');
    const screenshotTitle = `${heading.replace('Cypress Multithreaded Runner:', '')} ${timestamp}`.trim();

    // the BrowserStack link is added to the first message shown
    let bsoLinkPending = Boolean(browserStackObservabilityURL);
    const withBsoLink = (html) => {
        if (!html || !bsoLinkPending) {
            return html;
        }

        bsoLinkPending = false;
        return `<span style="font-weight: bold;">View the BrowserStack Test Observability report here: <a href="${escapeHtml(browserStackObservabilityURL)}">${escapeHtml(browserStackObservabilityURL)}</a></span><br><br>${html}`;
    };

    const escapeLines = (lines) => lines.map(escapeHtml).join('<br>');

    return `<body>
    <div class="cmr-hidden">
    <script type="application/json" id="cmr-run-config">${jsonForScript(runConfig)}</script>
    </div>
    <button id="cmr-take-screenshot">${SCREENSHOT_TEXT}</button>
    ${screenshotModal(screenshotTitle)}
    <div class="cmr-content cmr-header">
        <div class="cmr-${status} cmr-headline"><h2 id="cmr-collapse">➡️</h2><h2>${headingHtml}${criticalHtml ? ' [CRITICAL ERRORS - PLEASE READ]' : ''}</h2></div>
        ${summaryBlock('error', withBsoLink(criticalHtml))}
        ${summaryBlock('error', withBsoLink(escapeLines(errors)))}
        ${summaryBlock('warn', withBsoLink(escapeLines(warnings)))}
        ${status === 'success' ? summaryBlock('success', withBsoLink('Everything seems completely fine! No tests needed retrying.')) : ''}
        ${summaryBlock('notes', notes.map((note) => `NOTE: ${escapeHtml(note)}`).join('<br>'))}
    </div>`;
};

const collapsibleSection = (className, headingHtml, contentHtml) => `
    <div class="cmr-thread cmr-${className}">
        <span class="cmr-pre-heading cmr-sticky">
            <h2 id="cmr-arr-content">➡️</h2>
            <h2>${headingHtml}</h2>
        </span>
        <div id="cmr-pre-content" style="display:none;overflow:auto;margin-top:20px;">
        ${contentHtml}
        </div>
    </div>`;

// these warnings are noisy, so they're removed from the logs in the report
const removeNoisyLogs = (str) => str
    .replace(/Couldn't find tsconfig.json. tsconfig-paths will be skipped\n/g, '')
    .replace(/tput: No value for \$TERM and no -T specified\n/g, '');

/**
 * @param {object} options
 * @param {Array<{heading: string, content: string}>} options.customLogs
 * @param {Array<{status: string, heading: string[], logsTimestamped: Array<[string, string]>}>} options.threads
 * @param {string} options.performanceSummary
 * @param {boolean} options.expandHeader open the header when the report loads
 */
const buildReportFooter = ({ customLogs, threads, performanceSummary, expandHeader }) => {
    // custom logs are inserted as HTML, so users can include markup such as links
    const customLogsHtml = customLogs
        .map((customLog) => collapsibleSection('custom', customLog.heading, `<div class="cmr-thread-pre"><pre>${customLog.content}</pre></div>`))
        .join('');

    const threadLogsHtml = threads
        .filter((thread) => thread.logsTimestamped.length)
        .map((thread) => collapsibleSection(
            thread.status,
            thread.heading.map(escapeHtml).join('<br>'),
            thread.logsTimestamped.map(([time, log]) => `<div class="cmr-thread-pre">
                <pre>${time}</pre>
                <div class="cmr-thread-log-divide"></div>
                <pre>${escapeHtml(removeNoisyLogs(log))}</pre>
                </div>`).join(''),
        ))
        .join('');

    return `<div class="cmr-content cmr-footer"><section class="cmr-all-logs">${customLogsHtml}${threadLogsHtml}</section><div class="cmr-report">
        <span class="cmr-report-buttons">
            <button id="cmr-open-all">Open all logs above</button>
            <button id="cmr-close-all">Close all logs above</button>
            <span id="cmr-show-errors-only"><input type="checkbox" id="cmr-checkbox-show-errors-only" style="margin-right: 5px;vertical-align: bottom;" checked> Only show threads with errors/warnings</span>
        </span>
        <br><br><h2 class="cmr-sticky">Thread Performance Summary</h2><pre>${escapeHtml(performanceSummary)}</pre></div></div>
    <style>
${STYLES}
    </style>
    <style id="cmr-layout-hacks"></style>
    <style id="cmr-footer-hacks">.cmr-thread.cmr-success { display: none !important; }</style>
    <script>window.cmrReportOptions = ${JSON.stringify({ expandHeader: Boolean(expandHeader), screenshotText: SCREENSHOT_TEXT })};</script>
    <script src="${SNAPDOM_URL}"></script>
    <script>
${CLIENT_SCRIPT}
    </script>
</body>`;
};

/**
 * Add the header and footer to an Allure report HTML file
 */
const injectIntoReport = (htmlFile, header, footer) => {
    const html = fs.readFileSync(htmlFile, 'utf8');

    // functions as replacements, so "$" characters in the content aren't treated as patterns
    fs.writeFileSync(htmlFile, html.replace('<body>', () => header).replace('</body>', () => footer));
};

module.exports = {
    buildReportHeader,
    buildReportFooter,
    injectIntoReport,
};
