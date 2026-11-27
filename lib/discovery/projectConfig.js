// Loads a Cypress config file (the same way Cypress would find it) so that test discovery can locate
// the support file and the env/expose/config values that spec files might read when they're loaded

const fs = require('fs-extra');
const path = require('path');
const Module = require('module');
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

/**
 * Evaluate a Cypress config file. It's bundled first so that TypeScript and ESM config files work;
 * packages in node_modules are left as regular `require` calls
 */
const evaluateConfigFile = async (file) => {
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

    const exported = mod.exports?.default ?? mod.exports;

    return (typeof exported === 'function' ? await exported() : exported) || {};
};

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
 * @property {string|null} supportFile absolute path to the e2e support file, if any
 * @property {object} env values from the config file's `env` and cypress.env.json
 * @property {object} expose values from the config file's `expose`
 * @property {object} config the flattened e2e config
 * @property {string|null} error a description of why the config file couldn't be loaded
 */

/**
 * @param {object} options
 * @param {string|null} options.configFilepath the phase's cypressConfig.filepath
 * @param {object} options.configObject the phase's cypressConfig.object (overrides the file)
 * @param {string} options.projectRoot Cypress's project root (the working directory)
 * @returns {Promise<ProjectConfig>}
 */
const loadProjectConfig = async ({ configFilepath, configObject = {}, projectRoot = process.cwd() }) => {
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
        supportFile: resolveSupportFile(configObject.supportFile ?? e2eConfig.supportFile ?? fileConfig.supportFile, projectRoot),
        env: {
            ...fileConfig.env,
            ...e2eConfig.env,
            ...readJsonSafe(path.join(projectRoot, 'cypress.env.json'), {}),
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
    findConfigFile,
    resolveSupportFile,
};
