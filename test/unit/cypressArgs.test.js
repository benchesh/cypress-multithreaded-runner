const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { buildCypressArgs, phaseEnvString, phaseExposeString, envStringToObject } = require('../../lib/cypress/cypressArgs');
const { cypressEnv, resolveCypressBinary } = require('../../lib/cypress/cypressProcess');
const { normaliseSettings } = require('../../lib/config/settings');

const phaseWith = (overrides) => normaliseSettings({ phases: [overrides] }).phases[0];

describe('cypressArgs', () => {
    it('builds the same --env string as previous versions', () => {
        const phase = phaseWith({ grep: 'login', grepTags: '@smoke', grepUntagged: true, passthroughEnvArgs: 'a=1,grepOmitFiltered=true' });

        assert.equal(phaseEnvString(phase, { timestamp: 123 }), 'grepTags="@smoke",grep="login",grepUntagged="true",timestamp="123",a=1,grepOmitFiltered=true');
        assert.equal(phaseEnvString(phaseWith({})), '');
    });

    it('passes grep options via --expose as well, for @cypress/grep v6+', () => {
        const phase = phaseWith({ grep: 'login', passthroughEnvArgs: 'a=1,grepOmitFiltered=true' });

        assert.equal(phaseExposeString(phase), 'grep="login",grepOmitFiltered=true');
    });

    it('parses env strings', () => {
        assert.deepEqual(envStringToObject('a=1,b="x,y",c='), { a: '1', b: 'x,y', c: '' });
    });

    it('builds the full command line', () => {
        const phase = phaseWith({
            browser: 'chrome',
            grep: 'login',
            cypressConfig: { filepath: 'cypress.config.js', object: { reportDir: 'r' } },
        });

        const args = buildCypressArgs({
            phase,
            spec: 'cypress/e2e/a.cy.js',
            threadNo: 3,
            allureResultsDir: '/results',
            timestamp: 1,
            jUnitFile: '/junit/3.xml',
            supportsExpose: true,
        });

        assert.deepEqual(args, [
            'run',
            '--browser', 'chrome',
            '--config-file', 'cypress.config.js',
            '--reporter', 'junit', '--reporter-options', '{"mochaFile":"/junit/3.xml"}',
            '--e2e',
            '--config', '{"reportDir":"r","specPattern":["cypress/e2e/a.cy.js"]}',
            '--env', `allure=true,allureAddVideoOnPass=true,allureResults=${path.join('/results', '3')},grep="login",timestamp="1"`,
            '--expose', 'grep="login"',
        ]);
    });

    it('leaves out optional arguments', () => {
        const args = buildCypressArgs({ phase: phaseWith({}), spec: 'a.cy.js', threadNo: 1, allureResultsDir: '/r', timestamp: 1, supportsExpose: true });

        assert.deepEqual(args.filter((arg) => arg.startsWith('--')), ['--e2e', '--config', '--env']);
    });
});

describe('cypressProcess', () => {
    it('removes ELECTRON_RUN_AS_NODE, which stops Cypress from starting', () => {
        assert.deepEqual(cypressEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/bin' }), { PATH: '/bin' });
    });

    it('finds the project\'s Cypress installation', () => {
        const binary = resolveCypressBinary(path.join(__dirname, '..', '..'));

        assert.equal(binary.command, process.execPath);
        assert.match(binary.args[0], /cypress[/\\]bin[/\\]cypress$/);
        assert.match(binary.version, /^\d+\.\d+\.\d+/);
    });
});
