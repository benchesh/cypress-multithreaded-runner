// Loads a Cypress config file (the same way Cypress would find it) so that test discovery can locate
// the support file and the env/expose/config values that spec files might read when they're loaded

const fs = require('fs-extra');
const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');
const esbuild = require('esbuild');
const { readJsonSafe } = require('../util/fs');

const DEFAULT_CONFIG_FILES = ['cypress.config.js', 'cypress.config.ts', 'cypress.config.cjs', 'cypress.config.mjs', 'cypress.config.cts', 'cypress.config.mts'];
const DEFAULT_SUPPORT_FILES = ['js', 'jsx', 'ts', 'tsx'].map((ext) => path.join('cypress', 'support', `e2e.${ext}`));

const findConfigFile = (configFilepath, projectRoot) => {
    if (configFilepath) {
        const file = path.resolve(projectRoot, configFilepath);
        return fs.existsSync(file) ? file : null;
    }

    return DEFAULT_CONFIG_FILES.map((file) => path.join(projectRoot, file)).find((file) => fs.existsSync(file)) || null;
};

const TYPESCRIPT_EXTENSIONS = ['.ts', '.cts', '.mts', '.tsx'];

// errors that mean Node can't load a file with require(), as opposed to the file itself throwing an error
const UNLOADABLE_ERROR_CODES = ['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE', 'ERR_UNKNOWN_FILE_EXTENSION'];

/**
 * Compile TypeScript files with esbuild as they're required (as Cypress does with ts-node). Each file is compiled
 * separately, so each keeps its own __dirname, __filename and import.meta values
 *
 * @returns {() => void} undoes it
 */
const registerTypeScript = () => {
    const previous = Object.fromEntries(TYPESCRIPT_EXTENSIONS.map((ext) => [ext, Module._extensions[ext]]));

    TYPESCRIPT_EXTENSIONS.forEach((ext) => {
        Module._extensions[ext] = (mod, filename) => {
            const { code } = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), {
                loader: ext === '.tsx' ? 'tsx' : 'ts',
                format: 'cjs',
                platform: 'node',
                sourcefile: filename,
                logLevel: 'silent',
                define: {
                    'import.meta.url': JSON.stringify(pathToFileURL(filename).href),
                    'import.meta.dirname': JSON.stringify(path.dirname(filename)),
                    'import.meta.filename': JSON.stringify(filename),
                },
            });

            mod._compile(code, filename);
        };
    });

    return () => TYPESCRIPT_EXTENSIONS.forEach((ext) => {
        if (previous[ext]) {
            Module._extensions[ext] = previous[ext];
        } else {
            delete Module._extensions[ext];
        }
    });
};

/**
 * Bundle the config file, and the project files it imports, into a single module. Only used for config files that
 * Node can't load, as every bundled file gets the config file's __dirname
 */
const bundleConfigFile = async (file) => {
    const result = await esbuild.build({
        entryPoints: [file],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        packages: 'external',
        write: false,
        logLevel: 'silent',
    });

    const mod = new Module(file, module);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(result.outputFiles[0].text, file);

    return mod.exports;
};

/**
 * Evaluate a Cypress config file. As with Cypress, it's loaded with Node's own require(), so every file it
 * imports has the right __dirname (config files often use it to find .env files etc.). TypeScript is compiled
 * as it's required. If Node can't load it (e.g. an ES module with top-level await), it's bundled instead
 */
const evaluateConfigFile = async (file) => {
    const unregisterTypeScript = registerTypeScript();
    let exported;

    try {
        exported = require(file);
    } catch (err) {
        if (!(err instanceof SyntaxError) && !UNLOADABLE_ERROR_CODES.includes(err?.code)) {
            throw err;
        }

        exported = await bundleConfigFile(file);
    } finally {
        unregisterTypeScript();
    }

    exported = exported?.default ?? exported;

    return (typeof exported === 'function' ? await exported() : exported) || {};
};

/**
 * Cypress.env() values from the environment variables prefixed with CYPRESS_ (e.g. CYPRESS_host=x sets "host"), as
 * Cypress reads them. CYPRESS_INTERNAL_ variables are Cypress's own, so they're left out
 */
const cypressProcessEnv = (processEnv = process.env) => Object.fromEntries(Object.entries(processEnv)
    .filter(([key]) => /^cypress_/i.test(key) && !/^cypress_internal_/i.test(key))
    .map(([key, value]) => [key.slice('CYPRESS_'.length), value]));

const resolveSupportFile = (supportFile, projectRoot) => {
    if (supportFile === false) {
        return null;
    }

    if (supportFile) {
        const file = path.resolve(projectRoot, supportFile);
        return fs.existsSync(file) ? file : null;
    }

    return DEFAULT_SUPPORT_FILES.map((file) => path.join(projectRoot, file)).find((file) => fs.existsSync(file)) || null;
};

/**
 * @typedef {object} ProjectConfig
 * @property {string|null} configFile absolute path to the config file, if there is one
 * @property {boolean} hasSetupNodeEvents the config file has an e2e setupNodeEvents function
 * @property {string|null} supportFile absolute path to the e2e support file, if any
 * @property {object} env values from the config file's `env`, cypress.env.json and CYPRESS_ environment variables
 * @property {object} expose values from the config file's `expose`
 * @property {object} config the flattened e2e config
 * @property {string|null} error a description of why the config file couldn't be loaded
 */

/**
 * @param {object} options
 * @param {string|null} options.configFilepath the phase's cypressConfig.filepath
 * @param {object} options.configObject the phase's cypressConfig.object (overrides the file)
 * @param {string} options.projectRoot Cypress's project root (the working directory)
 * @param {object} [options.processEnv] the environment variables Cypress will be run with
 * @returns {Promise<ProjectConfig>}
 */
const loadProjectConfig = async ({ configFilepath, configObject = {}, projectRoot = process.cwd(), processEnv = process.env }) => {
    const file = findConfigFile(configFilepath, projectRoot);

    let fileConfig = {};
    let error = null;

    if (file) {
        try {
            fileConfig = await evaluateConfigFile(file);
        } catch (err) {
            error = `Failed to load the Cypress config file "${file}": ${err.message}`;
        }
    }

    const e2eConfig = fileConfig.e2e || {};
    const config = { ...fileConfig, ...e2eConfig, ...configObject };

    return {
        configFile: file,
        hasSetupNodeEvents: !error && typeof e2eConfig.setupNodeEvents === 'function',
        supportFile: resolveSupportFile(configObject.supportFile ?? e2eConfig.supportFile ?? fileConfig.supportFile, projectRoot),
        env: {
            ...fileConfig.env,
            ...e2eConfig.env,
            ...readJsonSafe(path.join(projectRoot, 'cypress.env.json'), {}),
            ...cypressProcessEnv(processEnv),
            ...configObject.env,
        },
        expose: {
            ...fileConfig.expose,
            ...e2eConfig.expose,
            ...configObject.expose,
        },
        config,
        error,
    };
};

module.exports = {
    loadProjectConfig,
    evaluateConfigFile,
    registerTypeScript,
    cypressProcessEnv,
    findConfigFile,
    resolveSupportFile,
};
