const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const { passesTextFilters, specMatchesFilter, findPhaseSpecFiles } = require('../../lib/specs/specFiles');
const { resolveSpecSelection, findFailsArray, parseFailsFromReport } = require('../../lib/specs/specSelection');
const { buildRunPlan, isPhaseSkippedByUser, discoveryItems } = require('../../lib/specs/runPlan');
const { normaliseSettings } = require('../../lib/config/settings');
const { createTempDir } = require('../helpers/tempDir');

const silent = () => { };

const filters = (overrides) => ({ includingAny: null, includingAll: null, notIncludingAny: null, notIncludingAll: null, ...overrides });

describe('passesTextFilters', () => {
    const content = 'describe("Login") it("@smoke logs in")';

    it('passes when there are no filters', () => {
        assert.equal(passesTextFilters(content, filters()), true);
    });

    it('applies the four filters case-insensitively', () => {
        assert.equal(passesTextFilters(content, filters({ includingAny: ['logout', 'login'] })), true);
        assert.equal(passesTextFilters(content, filters({ includingAny: ['logout'] })), false);
        assert.equal(passesTextFilters(content, filters({ includingAll: ['login', '@smoke'] })), true);
        assert.equal(passesTextFilters(content, filters({ includingAll: ['login', '@slow'] })), false);
        assert.equal(passesTextFilters(content, filters({ notIncludingAny: ['@slow'] })), true);
        assert.equal(passesTextFilters(content, filters({ notIncludingAny: ['@slow', '@smoke'] })), false);
        assert.equal(passesTextFilters(content, filters({ notIncludingAll: ['@slow', '@smoke'] })), true);
        assert.equal(passesTextFilters(content, filters({ notIncludingAll: ['login', '@smoke'] })), false);
    });
});

describe('specMatchesFilter', () => {
    it('matches the full path or a trailing portion with the same basename', () => {
        assert.equal(specMatchesFilter('cypress/e2e/login.cy.js', 'cypress/e2e/login.cy.js'), true);
        assert.equal(specMatchesFilter('cypress/e2e/login.cy.js', 'e2e/login.cy.js'), true);
        assert.equal(specMatchesFilter('cypress/e2e/login.cy.js', 'login.cy.js'), true);
        assert.equal(specMatchesFilter('cypress/e2e/login.cy.js', 'in.cy.js'), false);
        assert.equal(specMatchesFilter('cypress/e2e/login.cy.js', 'other/login.cy.js'), false);
    });
});

describe('findPhaseSpecFiles', () => {
    let temp;

    before(() => {
        temp = createTempDir({
            'specs/b.cy.js': 'it("b")',
            'specs/a.cy.ts': 'it("a") @smoke',
            'specs/nested/c.cy.js': 'it("c") @smoke',
            'specs/readme.md': '@smoke',
        });
    });

    after(() => temp.cleanup());

    it('finds spec files recursively, in alphabetical order, filtered by extension', () => {
        const [phase] = normaliseSettings({ specsDir: temp.file('specs') }).phases;

        assert.deepEqual(findPhaseSpecFiles(phase).map((file) => path.relative(temp.dir, file)), [
            path.join('specs', 'a.cy.ts'),
            path.join('specs', 'b.cy.js'),
            path.join('specs', 'nested', 'c.cy.js'),
        ]);
    });

    it('applies specFileExts and the text filters', () => {
        const [phase] = normaliseSettings({ specsDir: temp.file('specs'), specFileExts: ['js'], onlyRunSpecFilesIncludingAnyText: '@SMOKE' }).phases;

        assert.deepEqual(findPhaseSpecFiles(phase).map((file) => path.basename(file)), ['c.cy.js']);
    });

    it('returns nothing for a missing directory', () => {
        const [phase] = normaliseSettings({ specsDir: temp.file('missing') }).phases;
        assert.deepEqual(findPhaseSpecFiles(phase), []);
    });
});

describe('findFailsArray / parseFailsFromReport', () => {
    it('finds the first nested "fails" array', () => {
        assert.deepEqual(findFailsArray({ a: { b: { fails: ['x'] } } }), ['x']);
        assert.equal(findFailsArray({ a: 1 }), null);
        assert.equal(findFailsArray(['not', 'an', 'object']), null);
    });

    it('reads fails from an Allure report produced by the runner', () => {
        const html = `<html><body><div class="cmr-hidden"><script type="application/json" id="cmr-run-config">{
    "fails": ["a.cy.js"]
}</script></div></body></html>`;

        assert.deepEqual(parseFailsFromReport(html), ['a.cy.js']);
    });

    it('reads fails from a cmr-summary.json file', () => {
        assert.deepEqual(parseFailsFromReport(JSON.stringify({ summary: 'x', fails: ['b.cy.js'] })), ['b.cy.js']);
    });

    it('returns null for anything else', () => {
        assert.equal(parseFailsFromReport('<html></html>'), null);
        assert.equal(parseFailsFromReport('{not json'), null);
    });
});

describe('resolveSpecSelection', () => {
    let temp;
    let server;
    let serverUrl;

    const reportHtml = (fails) => `<body><script type="application/json" id="cmr-run-config">${JSON.stringify({ fails })}</script></body>`;

    before(async () => {
        temp = createTempDir({
            'reports/old/index.html': reportHtml(['old.cy.js']),
            'reports/new/index.html': reportHtml([]),
            'report.html': reportHtml(['local.cy.js']),
        });

        // make sure "old" is older than "new", which has no fails
        const past = new Date(Date.now() - 60 * 1000);
        fs.utimesSync(temp.file('reports/old/index.html'), past, past);

        server = http.createServer((req, res) => res.end(reportHtml(['remote.cy.js'])));
        await new Promise((resolve) => server.listen(0, resolve));
        serverUrl = `http://127.0.0.1:${server.address().port}/report.html`;
    });

    after(() => {
        temp.cleanup();
        server.close();
    });

    it('uses specFiles when no failed-spec source is given', async () => {
        const selection = await resolveSpecSelection(normaliseSettings({ specFiles: ['a.cy.js'] }), { log: silent });
        assert.deepEqual(selection, { specFiles: ['a.cy.js'], assumeOthersPassed: false, source: null });
    });

    it('runFailedSpecFilesFromObject accepts arrays, objects and JSON strings', async () => {
        const fromArray = await resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromObject: ['a.cy.js'] }), { log: silent });
        assert.deepEqual(fromArray.specFiles, ['a.cy.js']);
        assert.equal(fromArray.assumeOthersPassed, true);

        const fromObject = await resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromObject: { benchmark: { fails: ['b.cy.js'] } } }), { log: silent });
        assert.deepEqual(fromObject.specFiles, ['b.cy.js']);

        const fromString = await resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromObject: '{"x":{"fails":["c.cy.js"]}}' }), { log: silent });
        assert.deepEqual(fromString.specFiles, ['c.cy.js']);
    });

    it('runFailedSpecFilesFromObject rejects invalid input', async () => {
        await assert.rejects(resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromObject: '{nope' }), { log: silent }), /valid JSON/);
        await assert.rejects(resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromObject: { a: 1 } }), { log: silent }), /No "fails" array/);
        await assert.rejects(resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromObject: { fails: [] } }), { log: silent }), /No failed spec files/);
    });

    it('runFailedSpecFilesFromReportURL reads local files and URLs', async () => {
        const local = await resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromReportURL: temp.file('report.html') }), { log: silent });
        assert.deepEqual(local.specFiles, ['local.cy.js']);
        assert.equal(local.assumeOthersPassed, true);

        const remote = await resolveSpecSelection(normaliseSettings({ runFailedSpecFilesFromReportURL: serverUrl }), { log: silent });
        assert.deepEqual(remote.specFiles, ['remote.cy.js']);
    });

    it('runMostRecentlyFailedSpecFilesFromReportsDir uses the newest report that has fails', async () => {
        const selection = await resolveSpecSelection(normaliseSettings({ runMostRecentlyFailedSpecFilesFromReportsDir: temp.file('reports') }), { log: silent });

        assert.deepEqual(selection.specFiles, ['old.cy.js']);
        assert.equal(selection.assumeOthersPassed, true);
        assert.match(selection.source, /old/);
    });
});

describe('buildRunPlan', () => {
    let temp;

    before(() => {
        temp = createTempDir({
            'one/a.cy.js': '',
            'one/b.cy.js': '',
            'two/c.cy.js': '',
        });
    });

    after(() => temp.cleanup());

    const settingsFor = (config) => normaliseSettings({
        phases: [{ specsDir: temp.file('one') }, { specsDir: temp.file('two') }],
        ...config,
    });

    const specNames = (threads) => threads.map((thread) => `${thread.threadNo}:${path.basename(thread.spec)}`);

    it('creates one thread per spec file, in phase order', () => {
        const plan = buildRunPlan({ settings: settingsFor({}), selection: { specFiles: null, assumeOthersPassed: false } });

        assert.deepEqual(specNames(plan.threads), ['1:a.cy.js', '2:b.cy.js', '3:c.cy.js']);
        assert.equal(plan.threads[2].phaseNo, 2);
    });

    it('repeats every phase', () => {
        const plan = buildRunPlan({ settings: settingsFor({ repeat: 2 }), selection: { specFiles: null } });
        assert.deepEqual(specNames(plan.threads), ['1:a.cy.js', '2:b.cy.js', '3:a.cy.js', '4:b.cy.js', '5:c.cy.js', '6:c.cy.js']);
    });

    it('orders spec files by the benchmark, with unknown spec files first', () => {
        const plan = buildRunPlan({
            settings: settingsFor({}),
            selection: { specFiles: null },
            benchmarkOrder: [temp.file('one/b.cy.js'), temp.file('two/c.cy.js')],
        });

        assert.deepEqual(specNames(plan.threads), ['1:a.cy.js', '2:b.cy.js', '3:c.cy.js']);

        const reordered = buildRunPlan({
            settings: settingsFor({}),
            selection: { specFiles: null },
            benchmarkOrder: [temp.file('one/b.cy.js'), temp.file('one/a.cy.js')],
        });

        assert.deepEqual(specNames(reordered.threads), ['1:b.cy.js', '2:a.cy.js', '3:c.cy.js']);
    });

    it('skips phases the user excluded', () => {
        assert.deepEqual(specNames(buildRunPlan({ settings: settingsFor({ onlyPhaseNo: 2 }), selection: { specFiles: null } }).threads), ['1:c.cy.js']);
        assert.deepEqual(specNames(buildRunPlan({ settings: settingsFor({ endingPhaseNo: 1 }), selection: { specFiles: null } }).threads), ['1:a.cy.js', '2:b.cy.js']);
        assert.deepEqual(specNames(buildRunPlan({ settings: settingsFor({ startingPhaseNo: 2 }), selection: { specFiles: null } }).threads), ['1:c.cy.js']);
    });

    it('filters by spec files and reports the ones that were not found', () => {
        const plan = buildRunPlan({ settings: settingsFor({}), selection: { specFiles: ['b.cy.js', 'missing.cy.js'], assumeOthersPassed: false } });

        assert.deepEqual(specNames(plan.threads), ['1:b.cy.js']);
        assert.deepEqual(plan.missingSpecFiles, ['missing.cy.js']);
        assert.deepEqual(plan.phases.flatMap((phase) => phase.assumedPassedSpecs), []);
    });

    it('lists the spec files that are assumed to have passed when only failed spec files are re-run', () => {
        const plan = buildRunPlan({ settings: settingsFor({}), selection: { specFiles: ['b.cy.js'], assumeOthersPassed: true } });

        assert.deepEqual(plan.phases.map((phase) => phase.assumedPassedSpecs.map((spec) => path.basename(spec))), [['a.cy.js'], ['c.cy.js']]);
        assert.deepEqual(discoveryItems(plan).map(({ spec }) => path.basename(spec)), ['b.cy.js', 'a.cy.js', 'c.cy.js']);
    });

    it('isPhaseSkippedByUser treats unset options as not skipping', () => {
        const settings = normaliseSettings({});
        assert.equal(isPhaseSkippedByUser(settings, 1), false);
        assert.equal(isPhaseSkippedByUser({ ...settings, endingPhaseNo: 2 }, 3), true);
    });
});
