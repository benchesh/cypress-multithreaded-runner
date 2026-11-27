// A minimal, fake Cypress/Mocha environment in which spec files can be evaluated in Node.
// Test bodies and hooks are never executed; `describe`/`it` calls are only recorded, so tests created
// dynamically (loops, `it.each`, `Cypress._.times`, helper functions etc.) are counted correctly

const util = require('util');
const lodash = require('lodash');

/**
 * An object that absorbs any usage: every property is itself, calling or constructing it returns itself,
 * it iterates as empty and converts to an empty string. It's deliberately not "thenable"
 */
const createUniversalStub = () => {
    const target = function stub() { };

    const proxy = new Proxy(target, {
        get(_, key) {
            switch (key) {
                case 'prototype':
                    return target.prototype;
                case 'then':
                    return undefined;
                case 'length':
                    return 0;
                case 'toString':
                case 'valueOf':
                case 'toJSON':
                    return () => '';
                case Symbol.toPrimitive:
                    return () => '';
                case Symbol.iterator:
                    return function* emptyIterator() { };
                default:
                    return proxy;
            }
        },
        apply: () => proxy,
        construct: () => proxy,
        set: () => true,
    });

    return proxy;
};

const toTagArray = (options) => {
    const tags = options?.tags;

    if (typeof tags === 'string') {
        return [tags];
    }

    return Array.isArray(tags) ? tags.filter(Boolean).map(String) : [];
};

const normaliseArgs = (title, options, fn) => (
    typeof options === 'function' ? [title, {}, options] : [title, options || {}, fn]
);

/**
 * cypress-each compatible title formatting
 */
const makeEachTitle = (titlePattern, value, k, values) => {
    if (typeof titlePattern === 'function') {
        return titlePattern(value, k, values);
    }

    const title = String(titlePattern)
        .replace('%k', k)
        .replace('%K', k + 1)
        .replace('%N', values.length);

    const placeholderCount = (title.match(/%/g) || []).length;
    const formatValues = (Array.isArray(value) ? value : [value]).slice(0, placeholderCount);

    return util.format(title, ...formatValues);
};

/**
 * Records the tests registered by a spec file
 */
const createTestRecorder = (stub) => {
    const tests = [];
    const suiteStack = [];

    const createSuiteFn = (flags) => function describe(rawTitle, rawOptions, rawFn) {
        const [title, options, fn] = normaliseArgs(rawTitle, rawOptions, rawFn);

        if (typeof fn !== 'function') {
            return stub;
        }

        suiteStack.push({
            title: String(title),
            tags: toTagArray(options),
            pending: Boolean(flags.pending),
            only: Boolean(flags.only),
        });

        try {
            fn.call(stub);
        } finally {
            suiteStack.pop();
        }

        return stub;
    };

    const createTestFn = (flags) => function it(rawTitle, rawOptions, rawFn) {
        const [title, options, fn] = normaliseArgs(rawTitle, rawOptions, rawFn);

        tests.push({
            titlePath: suiteStack.map((suite) => suite.title),
            title: String(title),
            tags: [...new Set(suiteStack.flatMap((suite) => suite.tags).concat(toTagArray(options)))],
            pending: Boolean(flags.pending) || typeof fn !== 'function' || suiteStack.some((suite) => suite.pending),
            only: Boolean(flags.only) || suiteStack.some((suite) => suite.only),
        });

        return stub;
    };

    const createEach = (register) => function each(values, totalChunksOrFilter, chunkIndex) {
        let items = typeof values === 'number' ? lodash.range(values) : values;

        if (!Array.isArray(items)) {
            throw new Error('.each() expects an array or a number');
        }

        if (typeof totalChunksOrFilter === 'function') {
            items = items.filter(totalChunksOrFilter);
        } else if (Number.isInteger(totalChunksOrFilter) && Number.isInteger(chunkIndex)) {
            const chunkSize = Math.ceil(items.length / totalChunksOrFilter);
            items = items.slice(chunkIndex * chunkSize, (chunkIndex + 1) * chunkSize);
        }

        return (titlePattern, options, fn) => {
            const [, opts, callback] = normaliseArgs(titlePattern, options, fn);

            items.forEach((value, k) => {
                // test callbacks are never executed, but describe callbacks are (to register their tests)
                const wrapped = typeof callback === 'function'
                    ? function eachCallback() { return callback.call(this, value, k); }
                    : undefined;

                register(makeEachTitle(titlePattern, value, k, items), opts, wrapped);
            });
        };
    };

    const it = createTestFn({});
    it.only = createTestFn({ only: true });
    it.skip = createTestFn({ pending: true });
    it.each = createEach(it);
    it.only.each = createEach(it.only);
    it.skip.each = createEach(it.skip);
    it.retries = () => stub;

    const describe = createSuiteFn({});
    describe.only = createSuiteFn({ only: true });
    describe.skip = createSuiteFn({ pending: true });
    describe.each = createEach(describe);
    describe.only.each = createEach(describe.only);
    describe.skip.each = createEach(describe.skip);

    const hook = () => stub;

    return {
        globals: {
            describe,
            context: describe,
            xdescribe: describe.skip,
            xcontext: describe.skip,
            it,
            specify: it,
            xit: it.skip,
            xspecify: it.skip,
            before: hook,
            after: hook,
            beforeEach: hook,
            afterEach: hook,
        },
        getTests: () => tests,
    };
};

/**
 * Accessor in the style of Cypress.env()/Cypress.expose()/Cypress.config():
 * no args = all values, (key) = one value, (key, value) or (object) = set
 */
const createValueAccessor = (values) => (key, value) => {
    if (key === undefined) {
        return { ...values };
    }

    if (key && typeof key === 'object') {
        Object.assign(values, key);
        return undefined;
    }

    if (value !== undefined) {
        values[key] = value;
        return undefined;
    }

    return values[key];
};

const createCypressGlobal = ({ env, expose, config, spec }, stub) => {
    const known = {
        _: lodash,
        env: createValueAccessor({ ...env }),
        expose: createValueAccessor({ ...expose }),
        config: createValueAccessor({ ...config }),
        spec,
        platform: process.platform,
        arch: process.arch,
        browser: {
            name: 'electron',
            family: 'chromium',
            displayName: 'Electron',
            isHeadless: true,
            isHeaded: false,
        },
        Promise,
        Buffer,
    };

    return new Proxy(known, {
        get: (target, key) => (key in target ? target[key] : stub),
        set: (target, key, value) => {
            target[key] = value;
            return true;
        },
    });
};

const noop = () => 0;

/**
 * Create a fresh global object for evaluating one spec file (plus its support file)
 *
 * @param {object} options
 * @param {object} options.env values returned by Cypress.env()
 * @param {object} options.expose values returned by Cypress.expose()
 * @param {object} options.config values returned by Cypress.config()
 * @param {object} options.spec the value of Cypress.spec
 */
const createSandbox = ({ env = {}, expose = {}, config = {}, spec = {} } = {}) => {
    const stub = createUniversalStub();
    const recorder = createTestRecorder(stub);
    const silentConsole = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug', 'trace', 'table', 'dir', 'group', 'groupEnd'].map((m) => [m, noop]));

    const globals = {
        ...recorder.globals,
        Cypress: createCypressGlobal({ env, expose, config, spec }, stub),
        cy: stub,
        expect: stub,
        assert: stub,
        chai: stub,
        sinon: stub,
        $: stub,
        jQuery: stub,
        document: stub,
        location: stub,
        navigator: stub,
        localStorage: stub,
        sessionStorage: stub,
        fetch: stub,
        XMLHttpRequest: stub,
        console: silentConsole,
        setTimeout: noop,
        clearTimeout: noop,
        setInterval: noop,
        clearInterval: noop,
        setImmediate: noop,
        queueMicrotask: noop,
        requestAnimationFrame: noop,
        process: { env: { NODE_ENV: 'test' }, platform: process.platform, browser: true, cwd: () => '/' },
        Promise,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        Buffer,
        atob,
        btoa,
        structuredClone,
        __cmrStub: stub,
    };

    globals.window = globals;
    globals.self = globals;
    globals.global = globals;
    globals.top = globals;
    globals.parent = globals;

    return { globals, getTests: recorder.getTests };
};

module.exports = {
    createSandbox,
    createUniversalStub,
    makeEachTitle,
};
