const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const { TestDiscovery } = require('../../lib/discovery/discoverTests');
const { cypressProcessEnv } = require('../../lib/discovery/projectConfig');
const { toJsonSafe } = require('../../lib/discovery/setupNodeEvents');
const { normaliseSettings } = require('../../lib/config/settings');
const { createTempDir } = require('../helpers/tempDir');

// test titles that include Cypress.env()/Cypress.expose() values, as the spec files of a real project might
const SPEC = `
    const { subdomain } = Cypress.env();

    describe('Healthcheck', () => {
        ['editor', 'admin'].forEach((role) => {
            it(\`works on \${subdomain} as \${role}\`, () => {});
        });
        it(\`exposes \${Cypress.expose('label')}\`, () => {});
        it(\`combines \${Cypress.env('combined')}\`, () => {});
    });
`;

const configWithSetupNodeEvents = (body) => `
    const fs = require('fs');

    module.exports = {
        env: { fromConfigFile: 'config file' },
        e2e: {
            supportFile: false,
            async setupNodeEvents(on, config) {
                fs.appendFileSync('setup-node-events-runs.log', 'run\\n');
                ${body}
            },
        },
    };
`;

const SETS_VALUES = configWithSetupNodeEvents(`
    on('task', { anything: () => null });
    config.env.subdomain = process.env.CMR_TEST_SUBDOMAIN || 'release';
    config.env.combined = [config.env.fromConfigFile, config.env.fromCli, config.env.fromOsEnv].join(' + ');
    config.expose = { ...config.expose, label: 'from setupNodeEvents' };
    return config;
`);

describe('TestDiscovery with setupNodeEvents', () => {
    let temp;
    let logs;

    const phaseWith = (options = {}) => normaliseSettings({ phases: [{ specsDir: 'specs', ...options }] }).phases[0];

    const discover = async (config, { phases = [phaseWith()], timeoutMs, configFile = 'cypress.config.js', files = {} } = {}) => {
        temp = createTempDir({ [configFile]: config, 'specs/healthcheck.cy.js': SPEC, ...files });
        logs = [];

        const discovery = new TestDiscovery({ cwd: temp.dir, verboseLog: (msg) => logs.push(msg), setupNodeEventsTimeoutMs: timeoutMs });
        const results = await Promise.all(phases.map((phase) => discovery.discoverSpec(phase, 'specs/healthcheck.cy.js')));

        return results.map((result) => result.tests.map((test) => test.fullTitle));
    };

    const runCount = () => {
        const log = temp.file('setup-node-events-runs.log');
        return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
    };

    beforeEach(() => {
        process.env.CMR_TEST_SUBDOMAIN = 'develop';
        process.env.CYPRESS_fromOsEnv = 'environment variable';
    });

    afterEach(() => {
        delete process.env.CMR_TEST_SUBDOMAIN;
        delete process.env.CYPRESS_fromOsEnv;
        temp?.cleanup();
    });

    it('sees the Cypress.env() and Cypress.expose() values that setupNodeEvents sets, as the spec files will', async () => {
        const [titles] = await discover(SETS_VALUES, { phases: [phaseWith({ passthroughEnvArgs: 'fromCli=cli' })] });

        assert.deepEqual(titles, [
            'Healthcheck works on develop as editor',
            'Healthcheck works on develop as admin',
            'Healthcheck exposes from setupNodeEvents',
            // setupNodeEvents is given the env values from the config file, the phase's env args and CYPRESS_ environment variables
            'Healthcheck combines config file + cli + environment variable',
        ]);
        assert.deepEqual(logs, []);
    });

    it('runs setupNodeEvents once for phases with the same config', async () => {
        const phases = normaliseSettings({ phases: [{ specsDir: 'specs' }, { specsDir: 'specs' }, { specsDir: 'specs', passthroughEnvArgs: 'fromCli=other' }] }).phases;
        const titles = await discover(SETS_VALUES, { phases });

        assert.equal(titles[0][0], 'Healthcheck works on develop as editor');
        assert.deepEqual(titles[0], titles[1]);
        assert.equal(titles[2][3], 'Healthcheck combines config file + other + environment variable');
        assert.equal(runCount(), 2);
    });

    it('gives setupNodeEvents the files it requires as Node would load them, including TypeScript files', async () => {
        const [titles] = await discover(`
            export default {
                e2e: {
                    supportFile: false,
                    setupNodeEvents(on, config) {
                        // a helper that reads a .env file next to it, required when setupNodeEvents runs
                        const { readSubdomain } = require('./helpers/dotEnv.ts');
                        config.env.subdomain = readSubdomain();
                        return config;
                    },
                },
            };
        `, {
            configFile: 'cypress.config.ts',
            files: {
                // enums aren't supported by Node's own TypeScript support
                'helpers/dotEnv.ts': `
                    import fs from 'fs';
                    import path from 'path';

                    enum Key { Subdomain = 'SUBDOMAIN' }

                    export const readSubdomain = (): string => fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('=')[1].trim();
                    export const key = Key.Subdomain;
                `,
                'helpers/.env': 'SUBDOMAIN=from-dot-env',
            },
        });

        assert.equal(titles[0], 'Healthcheck works on from-dot-env as editor');
        assert.deepEqual(logs, []);
    });

    it('uses the config as it was changed, when setupNodeEvents does not return it', async () => {
        const [titles] = await discover(configWithSetupNodeEvents("config.env.subdomain = 'changed in place';"));

        assert.equal(titles[0], 'Healthcheck works on changed in place as editor');
    });

    it('carries on without the values when setupNodeEvents throws', async () => {
        const [titles] = await discover(configWithSetupNodeEvents("throw new Error('no database');"));

        assert.equal(titles[0], 'Healthcheck works on undefined as editor');
        assert.equal(titles.length, 4);
        assert.equal(logs.length, 1);
        assert.match(logs[0], /couldn't run setupNodeEvents from ".+cypress\.config\.js".*setupNodeEvents threw an error: Error: no database/s);
    });

    it('gives up on setupNodeEvents if it takes too long, without anything it started keeping the runner alive', async () => {
        const started = Date.now();
        const [titles] = await discover(configWithSetupNodeEvents(`
            console.log('starting a server');
            require('http').createServer().listen(0);
            await new Promise(() => { });
        `), { timeoutMs: 1000 });

        assert.ok(Date.now() - started < 10000);
        assert.equal(titles[0], 'Healthcheck works on undefined as editor');
        assert.match(logs[0], /setupNodeEvents didn't finish within 1 seconds\nstarting a server/);
    });

    it("doesn't run anything when there's no setupNodeEvents", async () => {
        const [titles] = await discover("module.exports = { env: { subdomain: 'static' }, e2e: { supportFile: false } };");

        assert.equal(titles[0], 'Healthcheck works on static as editor');
        assert.equal(runCount(), 0);
        assert.deepEqual(logs, []);
    });
});

describe('cypressProcessEnv', () => {
    it('reads CYPRESS_ environment variables as Cypress.env() values, except for Cypress internal ones', () => {
        assert.deepEqual(cypressProcessEnv({
            CYPRESS_host: 'example.com',
            cypress_lower: 'yes',
            CYPRESS_INTERNAL_ENV: 'production',
            CYPRESSFOO: 'no underscore',
            HOME: '/home/user',
        }), { host: 'example.com', lower: 'yes' });
    });
});

describe('toJsonSafe', () => {
    it('drops functions and circular references', () => {
        const value = { a: 1, fn: () => { }, nested: { list: [1, 'two'] } };
        value.self = value;

        assert.deepEqual(toJsonSafe(value), { a: 1, nested: { list: [1, 'two'] } });
        assert.deepEqual(toJsonSafe(undefined), {});
    });
});
