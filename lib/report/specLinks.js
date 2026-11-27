// Links the spec files mentioned in the Allure report's header and footer to those files in their git repo, at
// the commit that was tested (see the includeRepoPath option)

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { escapeHtml, shortenPath } = require('../util/format');

/**
 * Run git, returning its output, or null if it failed (e.g. not a repo, no commits, or git isn't installed)
 */
const git = (cwd, args) => {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).trim() || null;
    } catch {
        return null;
    }
};

/**
 * The web address of a repo, from the URL of its git remote, e.g. "git@github.com:acme/widgets.git" becomes
 * "https://github.com/acme/widgets". Credentials in the remote's URL are never included.
 *
 * Returns null for remotes that aren't on a web host, such as local paths, and for hosts that are ssh aliases
 * (e.g. "github-work:acme/widgets.git"), as their real hostname isn't known
 */
const remoteToWebUrl = (remote) => {
    if (!remote) {
        return null;
    }

    let url = remote.trim();

    // scp-like syntax: [user@]host:path
    const scpLike = url.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);

    if (scpLike) {
        url = `ssh://${scpLike[1]}/${scpLike[2]}`;
    }

    let parsed;

    try {
        parsed = new URL(url);
    } catch {
        return null;
    }

    const isWeb = ['http:', 'https:'].includes(parsed.protocol);

    if ((!isWeb && !['ssh:', 'git:'].includes(parsed.protocol)) || !parsed.hostname.includes('.')) {
        return null;
    }

    const repoPath = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');

    if (!repoPath) {
        return null;
    }

    // Azure DevOps' ssh remotes look like git@ssh.dev.azure.com:v3/<organisation>/<project>/<repo>
    if (parsed.hostname === 'ssh.dev.azure.com' && repoPath.startsWith('/v3/')) {
        const [organisation, project, repo] = repoPath.slice('/v3/'.length).split('/');
        return `https://dev.azure.com/${organisation}/${project}/_git/${repo}`;
    }

    // an ssh port isn't the web server's port, so it's dropped
    return isWeb ? `${parsed.protocol}//${parsed.host}${repoPath}` : `https://${parsed.hostname}${repoPath}`;
};

const encodePath = (posixPath) => posixPath.split('/').map(encodeURIComponent).join('/');

/**
 * The address of a file at a commit, on the site hosting the repo. Hosts that aren't recognised get GitHub's
 * layout, which GitHub Enterprise, Gitea and others share
 *
 * @param {string} webUrl see remoteToWebUrl
 * @param {string} commit
 * @param {string} pathInRepo with forward slashes
 */
const repoFileUrl = (webUrl, commit, pathInRepo) => {
    const { hostname } = new URL(webUrl);
    const encodedPath = encodePath(pathInRepo);

    if (hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')) {
        return `${webUrl}?path=/${encodedPath}&version=GC${commit}`;
    }

    if (hostname === 'bitbucket.org') {
        return `${webUrl}/src/${commit}/${encodedPath}`;
    }

    if (hostname.split('.').includes('gitlab')) {
        return `${webUrl}/-/blob/${commit}/${encodedPath}`;
    }

    return `${webUrl}/blob/${commit}/${encodedPath}`;
};

/**
 * The git repo a directory is in: its root, the commit that's checked out, and the web address of its remote
 * ("origin", or else the first remote)
 *
 * @returns {{root: string, commit: string|null, webUrl: string|null}|null} null if it isn't in a git repo
 */
const detectGitRepo = (dir) => {
    const root = git(dir, ['rev-parse', '--show-toplevel']);

    if (!root) {
        return null;
    }

    const remotes = (git(root, ['remote']) || '').split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];

    return {
        root,
        commit: git(root, ['rev-parse', 'HEAD']),
        webUrl: remote ? remoteToWebUrl(git(root, ['remote', 'get-url', remote])) : null,
    };
};

const realpath = (filepath) => {
    try {
        return fs.realpathSync(filepath);
    } catch {
        return path.resolve(filepath);
    }
};

/**
 * The path of a file within a directory, with forward slashes, or null if it isn't inside it. Symlinks are
 * resolved (git reports the real path of a repo, e.g. /private/var rather than /var on macOS)
 */
const pathWithin = (dir, file) => {
    const relative = path.relative(realpath(dir), realpath(file));

    return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : null;
};

/**
 * Works out the address to link each spec file to
 *
 * @param {object} options
 * @param {boolean|string} options.includeRepoPath true: link to the file in the git repo the spec file is in (if
 * it has a remote), at the current commit. A string: the URL of the repo at a commit, which the spec file's path
 * within the repo (or within cwd, if it isn't in a git repo) is added to. false: don't link
 * @param {string} [options.cwd] spec paths are relative to this
 * @param {(msg: string) => void} [options.warn]
 * @param {(dir: string) => object|null} [options.detect] see detectGitRepo
 * @returns {(spec: string) => string|null}
 */
const createSpecUrlResolver = ({ includeRepoPath, cwd = process.cwd(), warn = () => { }, detect = detectGitRepo }) => {
    if (!includeRepoPath) {
        return () => null;
    }

    // spec files in the same directory are in the same repo, so git only needs asking once per directory
    const repos = new Map();
    const repoOf = (file) => {
        const dir = path.dirname(file);

        if (!repos.has(dir)) {
            repos.set(dir, detect(dir));
        }

        return repos.get(dir);
    };

    if (typeof includeRepoPath === 'string') {
        let base;

        try {
            base = new URL(includeRepoPath);
        } catch {
            // not a URL
        }

        if (!['http:', 'https:'].includes(base?.protocol)) {
            warn(`WARNING: includeRepoPath ("${includeRepoPath}") isn't a web address, so the spec files in the Allure report won't link anywhere.`);
            return () => null;
        }

        const baseUrl = includeRepoPath.replace(/\/+$/, '');

        return (spec) => {
            const file = path.resolve(cwd, spec);
            const relative = pathWithin(repoOf(file)?.root || cwd, file);

            return relative ? `${baseUrl}/${encodePath(relative)}` : null;
        };
    }

    return (spec) => {
        const file = path.resolve(cwd, spec);
        const repo = repoOf(file);
        const relative = repo?.webUrl && repo.commit ? pathWithin(repo.root, file) : null;

        return relative ? repoFileUrl(repo.webUrl, repo.commit, relative) : null;
    };
};

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeAttribute = (str) => String(str).replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * Creates a function that turns the spec file paths in some (escaped) HTML into links. Paths are recognised as
 * the report shows them: in full or shortened (see shortenPath), and on their own rather than as part of
 * something else, e.g. "Thread #1 [cypress/e2e/login.cy.js]" or "(a.cy.js, b.cy.js)"
 *
 * @param {Map<string, string|null>} specUrls spec => the address to link it to (null for no link)
 * @returns {(html: string) => string}
 */
const createSpecLinker = (specUrls) => {
    // the escaped text of each path => its address, or null when two spec files would show the same text
    const urlsByText = new Map();

    specUrls.forEach((url, spec) => {
        if (!url) {
            return;
        }

        new Set([spec, shortenPath(spec)]).forEach((text) => {
            const key = escapeHtml(text);
            urlsByText.set(key, urlsByText.has(key) && urlsByText.get(key) !== url ? null : url);
        });
    });

    // longest first, so a path that ends with another one is matched in full
    const texts = [...urlsByText.keys()].filter((text) => urlsByText.get(text)).sort((a, b) => b.length - a.length);

    if (!texts.length) {
        return (html) => html;
    }

    const pattern = new RegExp(`(?<=^|[\\s\\[(,>])(?:${texts.map(escapeRegExp).join('|')})(?=$|[\\s\\]),<])`, 'g');

    return (html) => html.replace(pattern, (text) => `<a class="cmr-spec-link" href="${escapeAttribute(urlsByText.get(text))}" target="_blank" rel="noopener noreferrer">${text}</a>`);
};

module.exports = {
    remoteToWebUrl,
    repoFileUrl,
    detectGitRepo,
    createSpecUrlResolver,
    createSpecLinker,
};
