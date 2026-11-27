// Spawning and controlling Cypress instances

const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const killSync = require('kill-sync');

/**
 * The environment for Cypress child processes. ELECTRON_RUN_AS_NODE is removed because, when it leaks
 * in from the parent (e.g. a VS Code terminal or extension), the Cypress binary refuses to start
 */
const cypressEnv = (env = process.env) => {
    const result = { ...env };
    delete result.ELECTRON_RUN_AS_NODE;
    return result;
};

/**
 * Locate the Cypress CLI installed in the user's project, falling back to `cypress` on the PATH
 *
 * @returns {{command: string, args: string[], shell: boolean, version: string|null}}
 */
const resolveCypressBinary = (cwd = process.cwd()) => {
    try {
        const pkgPath = require.resolve('cypress/package.json', { paths: [cwd] });
        const pkg = require(pkgPath);
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.cypress;

        return {
            command: process.execPath,
            args: [path.join(path.dirname(pkgPath), bin)],
            shell: false,
            version: pkg.version,
        };
    } catch {
        return { command: 'cypress', args: [], shell: process.platform === 'win32', version: null };
    }
};

/**
 * Whether the installed Cypress supports the `--expose` flag (added in Cypress 15.10)
 */
const supportsExposeFlag = (binary) => {
    const result = spawnSync(binary.command, [...binary.args, 'run', '--help'], {
        env: cypressEnv(),
        encoding: 'utf8',
        shell: binary.shell,
        timeout: 60 * 1000,
    });

    return /--expose\b/.test(`${result.stdout || ''}${result.stderr || ''}`);
};

/**
 * A running Cypress instance. Emits `output` (string) for every chunk of stdout/stderr, then `exit` once
 */
class CypressProcess extends EventEmitter {
    /**
     * @param {object} options
     * @param {{command: string, args: string[], shell: boolean}} options.binary
     * @param {string[]} options.args
     * @param {string} [options.cwd]
     */
    constructor({ binary, args, cwd = process.cwd() }) {
        super();

        this.exited = false;

        this.child = spawn(binary.command, [...binary.args, ...args], {
            cwd,
            env: cypressEnv(),
            shell: binary.shell,
        });

        this.pid = this.child.pid;

        this.child.stdout.on('data', (data) => this.emit('output', data.toString()));
        this.child.stderr.on('data', (data) => this.emit('output', data.toString()));

        this.child.on('error', (err) => {
            this.emit('output', `Failed to start Cypress: ${err.message}\n`);
            this.finish(null);
        });

        this.child.on('exit', (code) => {
            // give any buffered output a moment to arrive, as grandchild processes may keep stdio open
            const timer = setTimeout(() => this.finish(code), 2000);
            this.child.once('close', () => {
                clearTimeout(timer);
                this.finish(code);
            });
        });
    }

    finish(code) {
        if (this.exited) {
            return;
        }

        this.exited = true;
        this.emit('exit', code);
    }

    /**
     * Kill the process and all of its descendants
     */
    kill() {
        if (this.exited || !this.pid) {
            return;
        }

        try {
            killSync(this.pid, 'SIGKILL', true);
        } catch {
            // the process may have exited already
        }
    }
}

module.exports = {
    CypressProcess,
    resolveCypressBinary,
    supportsExposeFlag,
    cypressEnv,
};
