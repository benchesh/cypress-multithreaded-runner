// Discovers every test in every spec file before any Cypress instance runs. This is what allows the
// runner to know the total number of tests, to fill in results for tests that never ran, and to
// calculate an accurate success percentage

const fs = require('fs-extra');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');
const { createSandbox } = require('./sandbox');
const { createGrepMatcher } = require('./grep');
const { loadProjectConfig } = require('./projectConfig');
const { runSetupNodeEvents, toJsonSafe, DEFAULT_TIMEOUT_MS } = require('./setupNodeEvents');
const { envStringToObject, phaseEnvString } = require('../cypress/cypressArgs');

const EVALUATION_TIMEOUT_MS = 10 * 1000;
const MAX_CONCURRENT_BUNDLES = 8;
const SKIP_STUB_RESOLUTION = Symbol('cmr-skip-stub');

/**
 * @typedef {object} DiscoveredTest
 * @property {string[]} titlePath the titles of the describe blocks containing the test
 * @property {string} title the test's title as the Allure report shows it (see reportedTitle)
 * @property {string} fullTitle titlePath and title joined by spaces, which is the full name the test's Allure results have
 * @property {string[]} tags @cypress/grep tags, including those inherited from describe blocks
 * @property {boolean} pending the test is skipped (it.skip, xit, no callback etc.)
 * @property {boolean} grepIncluded the test will be selected by the phase's grep options
 */

/**
 * @typedef {object} SpecDiscovery
 * @property {string} spec
 * @property {DiscoveredTest[]} tests
 * @property {boolean} estimated true if the spec couldn't be evaluated and the tests were found by a text scan
 * @property {string|null} error why evaluation failed, if it did
 */

// any import that can't be resolved (node built-ins, webpack aliases, missing packages...) becomes a stub
const stubUnresolvableImports = {
    name: 'cmr-stub-unresolvable-imports',
    setup(build) {
        build.onResolve({ filter: /.*/ }, async (args) => {
            if (args.pluginData === SKIP_STUB_RESOLUTION || args.kind === 'entry-point') {
                return undefined;
            }

            const result = await build.resolve(args.path, {
                kind: args.kind,
                importer: args.importer,
                resolveDir: args.resolveDir,
                pluginData: SKIP_STUB_RESOLUTION,
            });

            if (result.errors.length) {
                return { path: args.path, namespace: 'cmr-stub' };
            }

            return {
                path: result.path,
                namespace: result.namespace,
                external: result.external,
                sideEffects: result.sideEffects,
            };
        });

        build.onLoad({ filter: /.*/, namespace: 'cmr-stub' }, () => ({
            contents: 'module.exports = globalThis.__cmrStub;',
            loader: 'js',
        }));
    },
};

const ASSET_LOADERS = {
    ...Object.fromEntries(['.txt', '.html', '.xml', '.csv', '.md', '.feature', '.graphql', '.gql', '.yml', '.yaml'].map((ext) => [ext, 'text'])),
    ...Object.fromEntries(['.css', '.scss', '.sass', '.less', '.styl', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.mp4', '.webm', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.pdf', '.zip'].map((ext) => [ext, 'empty'])),
};

/**
 * Bundle a spec or support file into a single browser-style script
 */
const bundleFile = async (file, cwd) => {
    const result = await esbuild.build({
        entryPoints: [file],
        absWorkingDir: cwd,
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2020',
        logLevel: 'silent',
        loader: ASSET_LOADERS,
        define: {
            'process.env.NODE_ENV': '"test"',
            global: 'globalThis',
        },
        plugins: [stubUnresolvableImports],
    });

    return result.outputFiles[0].text;
};

/**
 * Last resort: find test titles with a regular expression. Tests in loops can't be counted this way,
 * and describe blocks aren't tracked, so these results are marked as estimates
 *
 * @returns {Array<Omit<DiscoveredTest, 'grepIncluded'|'fullTitle'>>}
 */
const scanForTests = (content) => {
    const regex = /(?:^|[^.\w$])(x?(?:it|specify))(?:\.(only|skip))?\s*\(\s*(['"`])((?:\\.|(?!\3)[^\\])*)\3/g;

    return [...content.matchAll(regex)].map(([, fn, modifier, , title]) => ({
        titlePath: [],
        title,
        tags: [],
        pending: fn.startsWith('x') || modifier === 'skip',
        only: modifier === 'only',
    }));
};

// Allure metadata in a test's title, e.g. @allure.id:123 or @allure.label.owner:someone (as in allure-js-commons)
const ALLURE_TITLE_METADATA = /(?:^|\s)@?allure\.([^:=\s]+)[:=]("[^"]+"|'[^']+'|`[^`]+`|\S+)/g;

/**
 * A test's title as allure-cypress reports it: without Allure metadata, repeated spaces, or spaces at either end (as
 * in allure-js-commons' extractMetadataFromString). Its describe titles are left as they are. The test's results
 * are matched to it by its full title, so a title like `created as a ${status} ${extra}` (with nothing in extra) has
 * to be tidied up in the same way
 */
const reportedTitle = (title) => title
    .replace(ALLURE_TITLE_METADATA, '')
    .split(' ')
    .filter(Boolean)
    .reduce((acc, word) => (/^[\n\r]/.test(word) ? acc + word : `${acc} ${word}`), '')
    .trim();

const finaliseTests = (rawTests, grepMatcher) => {
    const hasOnly = rawTests.some((test) => test.only);
    const selected = hasOnly ? rawTests.filter((test) => test.only) : rawTests;

    return selected.map(({ titlePath, title, tags, pending }) => {
        const reported = reportedTitle(title);

        return {
            titlePath,
            title: reported,
            fullTitle: [...titlePath, reported].join(' '),
            tags,
            pending,
            // @cypress/grep matches the full title as Mocha has it
            grepIncluded: grepMatcher([...titlePath, title].join(' '), tags),
        };
    });
};

/**
 * Run with at most `limit` promises in flight
 */
const mapWithConcurrency = async (items, limit, fn) => {
    const results = new Array(items.length);
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index], index);
        }
    };

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));

    return results;
};

class TestDiscovery {
    /**
     * @param {object} [options]
     * @param {string} [options.cwd] the Cypress project root
     * @param {(msg: string) => void} [options.verboseLog]
     */
    constructor({ cwd = process.cwd(), verboseLog = () => { }, setupNodeEventsTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        this.cwd = cwd;
        this.verboseLog = verboseLog;
        this.setupNodeEventsTimeoutMs = setupNodeEventsTimeoutMs;
        this.bundles = new Map();
        this.phaseContexts = new Map();
        this.nodeEventsConfigs = new Map();
    }

    bundle(file) {
        if (!this.bundles.has(file)) {
            this.bundles.set(file, bundleFile(file, this.cwd));
        }

        return this.bundles.get(file);
    }

    /**
     * The config after the config file's setupNodeEvents has run, as the spec files will see it. Phases with
     * the same config share the result, so it only runs once for each
     *
     * @returns {Promise<object|null>} null if it couldn't be run
     */
    nodeEventsConfig(project, { env, expose }) {
        // the testing-type sections have already been merged into project.config
        const flatConfig = Object.fromEntries(Object.entries(project.config).filter(([key]) => !['e2e', 'component', 'setupNodeEvents'].includes(key)));
        const config = toJsonSafe({
            ...flatConfig,
            env,
            expose,
            projectRoot: this.cwd,
            configFile: project.configFile,
            testingType: 'e2e',
            isTextTerminal: true,
            isInteractive: false,
            browsers: [],
        });
        const key = JSON.stringify([project.configFile, config]);

        if (!this.nodeEventsConfigs.has(key)) {
            this.nodeEventsConfigs.set(key, runSetupNodeEvents({
                configFile: project.configFile,
                config,
                projectRoot: this.cwd,
                timeoutMs: this.setupNodeEventsTimeoutMs,
            }).catch((err) => {
                this.verboseLog(`Test discovery: couldn't run setupNodeEvents from "${project.configFile}", so any Cypress.env() or Cypress.expose() values it sets aren't known: ${err.message}`);
                return null;
            }));
        }

        return this.nodeEventsConfigs.get(key);
    }

    /**
     * Everything about a phase that affects how its spec files evaluate
     */
    async getPhaseContext(phase) {
        if (!this.phaseContexts.has(phase.phaseNo)) {
            this.phaseContexts.set(phase.phaseNo, (async () => {
                const project = await loadProjectConfig({
                    configFilepath: phase.cypressConfigFilepath,
                    configObject: phase.cypressConfigObject,
                    projectRoot: this.cwd,
                });

                if (project.error) {
                    this.verboseLog(project.error);
                }

                const cliEnv = envStringToObject(phaseEnvString(phase));
                const grepEnv = Object.fromEntries(Object.entries(cliEnv).filter(([key]) => key.startsWith('grep')));

                let supportScript = null;

                if (project.supportFile) {
                    try {
                        // compiled once, then run before every spec (as Cypress does)
                        supportScript = new vm.Script(await this.bundle(project.supportFile), { filename: project.supportFile });
                    } catch (err) {
                        this.verboseLog(`Test discovery: failed to bundle the support file "${project.supportFile}": ${err.message}`);
                    }
                }

                let env = { ...project.env, ...cliEnv };
                let expose = { ...project.expose, ...grepEnv };
                let { config } = project;

                if (project.hasSetupNodeEvents) {
                    const resolved = await this.nodeEventsConfig(project, { env, expose });

                    if (resolved) {
                        env = resolved.env || env;
                        expose = resolved.expose || expose;
                        config = { ...config, ...resolved };
                    }
                }

                return {
                    supportScript,
                    env,
                    expose,
                    config,
                    grepMatcher: createGrepMatcher(cliEnv),
                };
            })());
        }

        return this.phaseContexts.get(phase.phaseNo);
    }

    async evaluateSpec(spec, context) {
        const specCode = await this.bundle(path.resolve(this.cwd, spec));
        const absolute = path.resolve(this.cwd, spec);

        const { globals, getTests } = createSandbox({
            env: context.env,
            expose: context.expose,
            config: context.config,
            spec: {
                name: path.basename(spec),
                relative: path.relative(this.cwd, absolute),
                absolute,
                fileExtension: path.extname(spec),
            },
        });

        const vmContext = vm.createContext(globals);

        if (context.supportScript) {
            try {
                context.supportScript.runInContext(vmContext, { timeout: EVALUATION_TIMEOUT_MS });
            } catch (err) {
                // the support file is only evaluated in case it defines globals that spec files use,
                // so an error here isn't fatal
                this.verboseLog(`Test discovery: the support file threw while being evaluated for "${spec}": ${err.message}`);
            }
        }

        vm.runInContext(specCode, vmContext, { timeout: EVALUATION_TIMEOUT_MS, filename: absolute });

        return getTests();
    }

    /**
     * @param {object} phase normalised phase settings
     * @param {string} spec path to the spec file
     * @returns {Promise<SpecDiscovery>}
     */
    async discoverSpec(phase, spec) {
        const context = await this.getPhaseContext(phase);

        try {
            return {
                spec,
                tests: finaliseTests(await this.evaluateSpec(spec, context), context.grepMatcher),
                estimated: false,
                error: null,
            };
        } catch (err) {
            const message = (err.errors?.[0]?.text) || err.message;

            return {
                spec,
                tests: finaliseTests(scanForTests(fs.readFileSync(path.resolve(this.cwd, spec), 'utf8')), context.grepMatcher),
                estimated: true,
                error: message,
            };
        }
    }

    /**
     * Discover the tests in many spec files
     *
     * @param {Array<{phase: object, spec: string}>} items
     * @returns {Promise<Map<string, SpecDiscovery>>} keyed by `${phaseNo}:${spec}`
     */
    async discoverAll(items) {
        const results = await mapWithConcurrency(items, MAX_CONCURRENT_BUNDLES, ({ phase, spec }) => this.discoverSpec(phase, spec));

        return new Map(items.map(({ phase, spec }, index) => [TestDiscovery.key(phase.phaseNo, spec), results[index]]));
    }

    static key(phaseNo, spec) {
        return `${phaseNo}:${spec}`;
    }
}

module.exports = {
    TestDiscovery,
    scanForTests,
    finaliseTests,
    reportedTitle,
    bundleFile,
};
