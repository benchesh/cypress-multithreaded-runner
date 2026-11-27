const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const Module = require('module');
const { pathToFileURL } = require('url');
const { evaluateConfigFile } = require('../../lib/discovery/projectConfig');
const { createTempDir } = require('../helpers/tempDir');

describe('evaluateConfigFile', () => {
    let temp;

    const evaluate = (files, configFile) => {
        temp = createTempDir(files);
        return evaluateConfigFile(temp.file(configFile));
    };

    // the directory as Node sees it (on macOS the temp directory is behind a symlink)
    const realDir = (relative) => fs.realpathSync(temp.file(relative));

    afterEach(() => temp?.cleanup());

    it('loads the config file as Node does, so every file it requires has its own __dirname', async () => {
        const config = await evaluate({
            'config/cypress.config.js': "module.exports = { env: require('../utils/values') };",
            // e.g. a helper that reads a .env file next to it
            'utils/values.js': "module.exports = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'values.json'), 'utf8'));",
            'utils/values.json': '{ "label": "next to values.js" }',
        }, 'config/cypress.config.js');

        assert.deepEqual(config.env, { label: 'next to values.js' });
    });

    it('compiles TypeScript config files, and the TypeScript files they import, one file at a time', async () => {
        const originalTypeScriptLoader = Module._extensions['.ts'];
        const config = await evaluate({
            'cypress.config.ts': `
                import { where, Mode } from './helpers/where';

                const mode: Mode = Mode.Run;

                export default { env: { where, mode } };
            `,
            // enums aren't supported by Node's own TypeScript support
            'helpers/where.ts': `
                export enum Mode { Run = 'run' }
                export const where: Record<string, string> = { dirname: __dirname, url: import.meta.url };
            `,
        }, 'cypress.config.ts');

        assert.deepEqual(config.env, {
            where: { dirname: realDir('helpers'), url: pathToFileURL(realDir('helpers/where.ts')).href },
            mode: 'run',
        });
        assert.equal(Module._extensions['.ts'], originalTypeScriptLoader, "Node's own handling of TypeScript files wasn't put back");
    });

    it("bundles the config file if Node can't load it", async () => {
        const config = await evaluate({
            // ES module syntax in a package that says it's CommonJS
            'package.json': '{ "type": "commonjs" }',
            'cypress.config.js': "import { label } from './label.js'; export default { env: { label } };",
            'label.js': "export const label = 'bundled';",
        }, 'cypress.config.js');

        assert.deepEqual(config.env, { label: 'bundled' });
    });

    it('reports an error the config file throws, without running it again another way', async () => {
        await assert.rejects(evaluate({
            'cypress.config.js': `
                require('fs').appendFileSync(require('path').join(__dirname, 'runs.log'), 'run\\n');
                throw new Error('missing setting');
            `,
        }, 'cypress.config.js'), /missing setting/);

        assert.equal(fs.readFileSync(temp.file('runs.log'), 'utf8'), 'run\n');
    });
});
