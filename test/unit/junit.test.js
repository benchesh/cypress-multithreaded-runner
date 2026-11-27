const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const http = require('http');
const { buildJUnitReport, processJUnitReports } = require('../../lib/report/junit');
const { createTempDir } = require('../helpers/tempDir');

const result = (spec, fullTitle, status, extra = {}) => ({
    spec,
    fullTitle,
    title: fullTitle.split(' ').slice(1).join(' '),
    status,
    start: 1000,
    stop: 1250,
    message: '',
    trace: '',
    ...extra,
});

describe('buildJUnitReport', () => {
    it('includes every test once, with its final result, as the Allure report does', () => {
        // in no particular order, as results are collected
        const { xml, tests } = buildJUnitReport([
            result('b.cy.js', 'B skipped', 'skipped', { message: 'This test is pending.' }),
            // filled in by the runner, as its thread crashed
            result('a.cy.js', 'A broken', 'broken', { message: 'Cypress crashed', start: 6000, stop: 6000 }),
            // failed, then passed when its spec file was retried (retryAllFailedSpecs)
            result('a.cy.js', 'A retried', 'passed', { start: 5000, stop: 5100 }),
            result('a.cy.js', 'A retried', 'failed', { message: 'expected 1 to equal 2', trace: 'AssertionError: expected 1 to equal 2\n    at a.cy.js:3' }),
            result('b.cy.js', 'B failed', 'failed', { message: 'expected true', trace: 'AssertionError: expected true\n    at b.cy.js:9' }),
            result('b.cy.js', 'B unknown', 'unknown', { start: 1100, stop: 1350 }),
        ]);

        assert.equal(tests, 5);
        assert.equal(xml, [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<testsuites name="Cypress Multithreaded Runner" tests="5" failures="1" errors="2" skipped="1" time="0.850">',
            '  <testsuite name="a.cy.js" file="a.cy.js" tests="2" failures="0" errors="1" skipped="0" time="0.100">',
            '    <testcase name="A retried" classname="retried" file="a.cy.js" time="0.100" />',
            '    <testcase name="A broken" classname="broken" file="a.cy.js" time="0.000">',
            '      <error message="Cypress crashed">Cypress crashed</error>',
            '    </testcase>',
            '  </testsuite>',
            '  <testsuite name="b.cy.js" file="b.cy.js" tests="3" failures="1" errors="1" skipped="1" time="0.750">',
            '    <testcase name="B skipped" classname="skipped" file="b.cy.js" time="0.250">',
            '      <skipped message="This test is pending." />',
            '    </testcase>',
            '    <testcase name="B failed" classname="failed" file="b.cy.js" time="0.250">',
            '      <failure message="expected true" type="AssertionError">AssertionError: expected true',
            '    at b.cy.js:9</failure>',
            '    </testcase>',
            '    <testcase name="B unknown" classname="unknown" file="b.cy.js" time="0.250">',
            '      <error message="The test&apos;s result is unknown"></error>',
            '    </testcase>',
            '  </testsuite>',
            '</testsuites>',
            '',
        ].join('\n'));
    });

    it('escapes everything, and removes characters that XML does not allow, so the report is always valid', () => {
        const { xml } = buildJUnitReport([
            result('specs/<odd> & "quoted".cy.js', 'Suite handles <b>, & and "quotes" in \'titles\'', 'failed', {
                message: 'expected \u001b[31m"a"\u001b[39m to equal <b>\nsecond line\u0007\uD800',
                trace: 'Error: expected "a" to equal <b> & </failure>]]>\u0000',
            }),
        ]);

        assert.match(xml, /<testsuite name="specs\/&lt;odd&gt; &amp; &quot;quoted&quot;\.cy\.js" file="specs\/&lt;odd&gt; &amp; &quot;quoted&quot;\.cy\.js"/);
        assert.match(xml, /<testcase name="Suite handles &lt;b&gt;, &amp; and &quot;quotes&quot; in &apos;titles&apos;"/);
        // colours and control characters are removed, and line breaks are kept
        assert.match(xml, /<failure message="expected &quot;a&quot; to equal &lt;b&gt;&#10;second line" type="Error">Error: expected &quot;a&quot; to equal &lt;b&gt; &amp; &lt;\/failure&gt;]]&gt;<\/failure>/);
    });

    it('creates a valid report when there are no results', () => {
        assert.deepEqual(buildJUnitReport([]), {
            xml: '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="Cypress Multithreaded Runner" tests="0" failures="0" errors="0" skipped="0" time="0.000">\n</testsuites>\n',
            tests: 0,
        });
    });
});

describe('processJUnitReports', () => {
    let temp;
    let server;
    let requests;
    let respond;
    let logs;
    const originalConsole = { log: console.log, warn: console.warn, error: console.error };

    const jUnitReport = (upload = true) => ({
        enabled: true,
        browserStackTestObservabilityUpload: upload ? {
            username: 'user',
            accessKey: 'key',
            endpoint: `http://127.0.0.1:${server.address().port}/upload`,
            parameters: { buildName: 'build' },
        } : null,
    });

    const process = (results, upload) => processJUnitReports({
        reportDir: temp.file('report'),
        jUnitReport: jUnitReport(upload),
        results,
        allureReportDir: temp.file('report/allure-report'),
    });

    beforeEach(async () => {
        temp = createTempDir();
        requests = [];
        logs = [];
        respond = (res) => res.end(JSON.stringify({ message: 'View test reports at https://observability.example/builds/1' }));
        server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                requests.push({ headers: req.headers, body });
                respond(res);
            });
        });
        await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
        // without colours
        // eslint-disable-next-line no-control-regex
        ['log', 'warn', 'error'].forEach((level) => { console[level] = (...args) => logs.push([level, args.join(' ').replace(/\u001b\[\d+m/g, '')]); });
    });

    afterEach(() => {
        Object.assign(console, originalConsole);
        server.close();
        temp.cleanup();
    });

    it('saves the report and uploads it to BrowserStack Test Observability, linking to it from the Allure report', async () => {
        const url = await process([result('a.cy.js', 'A passes', 'passed'), result('a.cy.js', 'A fails', 'failed', { message: 'no' })]);

        assert.equal(url, 'https://observability.example/builds/1');
        assert.match(fs.readFileSync(temp.file('report/combined-junit-report.xml'), 'utf8'), /tests="2" failures="1"/);
        assert.match(fs.readFileSync(temp.file('report/allure-report/browserstack_test_observability_report.html'), 'utf8'), /url=https:\/\/observability\.example\/builds\/1/);

        assert.equal(requests.length, 1);
        assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from('user:key').toString('base64')}`);
        assert.match(requests[0].body, /filename="combined-junit-report-bso\.xml"/);
        assert.match(requests[0].body, /<testcase name="A passes"/);
        assert.match(requests[0].body, /name="buildName"\r\n\r\nbuild/);
        assert.ok(logs.some(([level, msg]) => level === 'log' && msg.includes('Uploaded the JUnit report (2 tests) to http://127.0.0.1')), JSON.stringify(logs));
    });

    it("doesn't upload a report without any tests", async () => {
        assert.equal(await process([]), null);

        assert.equal(requests.length, 0);
        assert.match(fs.readFileSync(temp.file('report/combined-junit-report.xml'), 'utf8'), /tests="0"/);
        assert.deepEqual(logs.map(([level]) => level), ['warn']);
        assert.match(logs[0][1], /no test results, so the JUnit report is empty and hasn't been uploaded to BrowserStack Test Observability/);
    });

    it('reports an upload that BrowserStack rejects as an error, rather than as uploaded', async () => {
        respond = (res) => {
            res.statusCode = 401;
            res.end(JSON.stringify({ message: 'Invalid credentials' }));
        };

        assert.equal(await process([result('a.cy.js', 'A passes', 'passed')]), null);

        assert.equal(requests.length, 1);
        assert.deepEqual(logs.map(([level]) => level), ['error']);
        assert.match(logs[0][1], /The JUnit report failed to upload to http:\/\/127\.0\.0\.1:\d+\/upload: Error: 401 Unauthorized: Invalid credentials/);
        assert.ok(!fs.existsSync(temp.file('report/allure-report/browserstack_test_observability_report.html')));
    });

    it("only saves the report when it isn't being uploaded", async () => {
        assert.equal(await process([result('a.cy.js', 'A passes', 'passed')], false), null);

        assert.equal(requests.length, 0);
        assert.deepEqual(logs, []);
        assert.ok(fs.existsSync(temp.file('report/combined-junit-report.xml')));
        assert.ok(!fs.existsSync(temp.file('report/combined-junit-report-bso.xml')));
    });
});
