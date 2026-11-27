const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { TestDiscovery, scanForTests } = require('../../lib/discovery/discoverTests');
const { makeEachTitle, createUniversalStub } = require('../../lib/discovery/sandbox');
const { normaliseSettings } = require('../../lib/config/settings');
const { createTempDir } = require('../helpers/tempDir');
const { keepFiles } = require('../helpers/artifacts');

const SPECS = {
    'cypress.config.js': `
        module.exports = {
            env: { users: ['ann', 'bob'] },
            e2e: { supportFile: 'cypress/support/e2e.js' },
        };
    `,
    'cypress/support/e2e.js': `
        // globals defined by the support file must be available to specs
        window.itForEachViewport = (title, fn) => ['mobile', 'desktop'].forEach((viewport) => it(\`\${title} (\${viewport})\`, fn));
        Cypress.Commands.add('login', () => {});
        beforeEach(() => cy.visit('/'));
    `,
    'cypress/fixtures/rows.json': JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]),
    'specs/basic.cy.js': `
        describe('Basic', () => {
            it('one', () => {});
            describe('nested', { tags: '@smoke' }, () => {
                it('two', { tags: ['@slow'] }, () => {});
                specify('three', () => {});
            });
            context('ctx', () => {
                it('four', () => {});
            });
        });
        it('root level', () => {});
    `,
    'specs/loops.cy.js': `
        import rows from '../cypress/fixtures/rows.json';
        describe('Loops', () => {
            for (let i = 0; i < 3; i++) {
                it(\`for \${i}\`, () => {});
            }
            rows.forEach((row) => it(\`row \${row.id}\`, () => {}));
            Cypress._.times(2, (k) => it(\`times \${k}\`, () => {}));
            Cypress.env('users').forEach((user) => it(\`user \${user}\`, () => {}));
            it.each([1, 2])('each %d', () => {});
            it.each([['a', 1]])('each tuple %s %d', () => {});
            it.each(['x', 'y'])((item, k) => \`fn \${item} \${k}\`, () => {});
            describe.each(['chrome', 'firefox'])('browser %s', () => {
                it('works', () => {});
            });
            itForEachViewport('viewport', () => {});
        });
    `,
    'specs/skips.cy.js': `
        describe('Skips', () => {
            it.skip('skipped', () => {});
            xit('x skipped', () => {});
            it('no callback');
            describe.skip('skipped suite', () => {
                it('inside skipped suite', () => {});
            });
            it('runs', () => {});
        });
    `,
    'specs/only.cy.js': `
        describe('Only', () => {
            it('ignored', () => {});
            it.only('chosen', () => {});
            describe.only('chosen suite', () => {
                it('chosen too', () => {});
            });
        });
    `,
    'specs/typescript.cy.ts': `
        interface Case { title: string }
        const cases: Case[] = [{ title: 'ts one' }, { title: 'ts two' }];
        describe('TypeScript', () => {
            cases.forEach(({ title }: Case) => it(title, () => {}));
        });
    `,
    'specs/imports.cy.js': `
        import fs from 'fs';
        import { helper } from 'a-package-that-does-not-exist';
        import '../cypress/styles.css';
        import 'cypress-each';
        describe('Imports', () => {
            it('still counted', () => { helper(fs); });
        });
    `,
    'specs/broken.cy.js': `
        describe('Broken', () => {
            it('found by the text scan', () => {});
            it.skip('skipped by the text scan', () => {});
            undefinedFunction();
        });
    `,
};

describe('TestDiscovery', () => {
    let temp;
    let discovery;
    let phase;

    const discovered = {};

    const discover = async (spec, phaseOverride = phase) => {
        const result = await discovery.discoverSpec(phaseOverride, `specs/${spec}`);
        discovered[`${spec}${phaseOverride === phase ? '' : ' (with grep)'}`] = result;
        return result;
    };
    const titles = (result) => result.tests.map((test) => test.fullTitle);

    before(() => {
        temp = createTempDir(SPECS);
        discovery = new TestDiscovery({ cwd: temp.dir });
        [phase] = normaliseSettings({ specsDir: 'specs' }).phases;
    });

    after(() => {
        // every spec file used above, and the tests found in each
        keepFiles({ kind: 'unit', suite: 'discovery', name: 'discovered tests' }, {
            'discovered-tests.json': discovered,
            ...Object.fromEntries(Object.keys(SPECS).filter((file) => file.startsWith('specs/')).map((file) => [file, SPECS[file]])),
        });
        temp.cleanup();
    });

    it('records tests with their describe titles and inherited tags', async () => {
        const result = await discover('basic.cy.js');

        assert.equal(result.estimated, false);
        assert.deepEqual(titles(result), ['Basic one', 'Basic nested two', 'Basic nested three', 'Basic ctx four', 'root level']);
        assert.deepEqual(result.tests[1].titlePath, ['Basic', 'nested']);
        assert.deepEqual(result.tests[1].tags, ['@smoke', '@slow']);
        assert.ok(result.tests.every((test) => !test.pending && test.grepIncluded));
    });

    it('counts tests created in loops, each, fixtures, Cypress._, Cypress.env and support file helpers', async () => {
        const result = await discover('loops.cy.js');

        assert.equal(result.error, null);
        assert.deepEqual(titles(result), [
            'Loops for 0',
            'Loops for 1',
            'Loops for 2',
            'Loops row 1',
            'Loops row 2',
            'Loops row 3',
            'Loops times 0',
            'Loops times 1',
            'Loops user ann',
            'Loops user bob',
            'Loops each 1',
            'Loops each 2',
            'Loops each tuple a 1',
            'Loops fn x 0',
            'Loops fn y 1',
            'Loops browser chrome works',
            'Loops browser firefox works',
            'Loops viewport (mobile)',
            'Loops viewport (desktop)',
        ]);
    });

    it('marks skipped tests as pending', async () => {
        const result = await discover('skips.cy.js');

        assert.deepEqual(result.tests.map((test) => [test.title, test.pending]), [
            ['skipped', true],
            ['x skipped', true],
            ['no callback', true],
            ['inside skipped suite', true],
            ['runs', false],
        ]);
    });

    it('honours .only', async () => {
        assert.deepEqual(titles(await discover('only.cy.js')), ['Only chosen', 'Only chosen suite chosen too']);
    });

    it('evaluates TypeScript', async () => {
        assert.deepEqual(titles(await discover('typescript.cy.ts')), ['TypeScript ts one', 'TypeScript ts two']);
    });

    it('stubs imports that cannot be resolved', async () => {
        const result = await discover('imports.cy.js');

        assert.equal(result.error, null);
        assert.deepEqual(titles(result), ['Imports still counted']);
    });

    it('falls back to a text scan when a spec cannot be evaluated', async () => {
        const result = await discover('broken.cy.js');

        assert.equal(result.estimated, true);
        assert.match(result.error, /undefinedFunction/);
        assert.deepEqual(result.tests.map((test) => [test.title, test.pending]), [
            ['found by the text scan', false],
            ['skipped by the text scan', true],
        ]);
    });

    it('applies the phase grep options', async () => {
        const [grepPhase] = normaliseSettings({ specsDir: 'specs', grepTags: '@slow' }).phases;
        grepPhase.phaseNo = 99; // a separate phase context

        const result = await discover('basic.cy.js', grepPhase);

        assert.deepEqual(result.tests.filter((test) => test.grepIncluded).map((test) => test.fullTitle), ['Basic nested two']);
    });

    it('discovers many specs at once, keyed by phase and spec', async () => {
        const results = await discovery.discoverAll([
            { phase, spec: 'specs/basic.cy.js' },
            { phase, spec: 'specs/only.cy.js' },
        ]);

        assert.equal(results.get(TestDiscovery.key(1, 'specs/basic.cy.js')).tests.length, 5);
        assert.equal(results.get(TestDiscovery.key(1, 'specs/only.cy.js')).tests.length, 2);
    });
});

describe('scanForTests', () => {
    it('finds test titles in source text', () => {
        const tests = scanForTests(`
            it('single', () => {});
            it.only("double", () => {});
            specify(\`template\`, () => {});
            xit('pending', () => {});
            obj.it('not a test');
        `);

        assert.deepEqual(tests.map((test) => [test.title, test.pending, test.only]), [
            ['single', false, false],
            ['double', false, true],
            ['template', false, false],
            ['pending', true, false],
        ]);
    });
});

describe('makeEachTitle', () => {
    it('formats titles like cypress-each', () => {
        assert.equal(makeEachTitle('item %s', 'a', 0, ['a']), 'item a');
        assert.equal(makeEachTitle('%k/%K of %N: %s', 'a', 0, ['a', 'b']), '0/1 of 2: a');
        assert.equal(makeEachTitle('%s plus %d', ['a', 2], 0, [['a', 2]]), 'a plus 2');
        assert.equal(makeEachTitle('no placeholders', 'a', 0, ['a']), 'no placeholders');
        assert.equal(makeEachTitle((value, k) => `${value}-${k}`, 'a', 3, []), 'a-3');
    });
});

describe('createUniversalStub', () => {
    it('absorbs any usage', () => {
        const stub = createUniversalStub();

        assert.equal(stub.a.b.c(), stub);
        assert.equal(`${stub}`, '');
        assert.deepEqual([...stub], []);
        assert.equal(stub.then, undefined);
        assert.ok(new stub.Thing() === stub);
    });
});
