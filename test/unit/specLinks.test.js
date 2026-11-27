// Links from the spec files in the Allure report to their repo (see includeRepoPath)

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');
const { remoteToWebUrl, repoFileUrl, detectGitRepo, createSpecUrlResolver, createSpecLinker } = require('../../lib/report/specLinks');
const { escapeHtml, shortenPath } = require('../../lib/util/format');
const { createTempDir } = require('../helpers/tempDir');

// the repos made here mustn't be affected by the git config of whoever runs the tests (e.g. url.insteadOf rewrites)
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();

describe('remoteToWebUrl', () => {
    it('turns git remotes into the web address of the repo', () => {
        const cases = {
            'git@github.com:acme/widgets.git': 'https://github.com/acme/widgets',
            'https://github.com/acme/widgets.git': 'https://github.com/acme/widgets',
            'https://github.com/acme/widgets/': 'https://github.com/acme/widgets',
            'ssh://git@github.com/acme/widgets.git': 'https://github.com/acme/widgets',
            // an ssh port isn't the web server's
            'ssh://git@git.example.com:7999/acme/widgets.git': 'https://git.example.com/acme/widgets',
            // but an http(s) port is
            'http://git.internal:8080/acme/widgets.git': 'http://git.internal:8080/acme/widgets',
            'git@gitlab.com:group/subgroup/widgets.git': 'https://gitlab.com/group/subgroup/widgets',
            'git@bitbucket.org:acme/widgets.git': 'https://bitbucket.org/acme/widgets',
            'git@ssh.dev.azure.com:v3/acme/project/widgets': 'https://dev.azure.com/acme/project/_git/widgets',
            'https://acme@dev.azure.com/acme/project/_git/widgets': 'https://dev.azure.com/acme/project/_git/widgets',
        };

        Object.entries(cases).forEach(([remote, expected]) => assert.equal(remoteToWebUrl(remote), expected, remote));
    });

    it('never includes credentials', () => {
        assert.equal(remoteToWebUrl('https://user:s3cret-token@github.com/acme/widgets.git'), 'https://github.com/acme/widgets');
        assert.equal(remoteToWebUrl('https://x-access-token:abc@github.com/acme/widgets'), 'https://github.com/acme/widgets');
    });

    it('returns null for remotes that are not on a known web host', () => {
        [
            '/srv/git/widgets.git',
            '../widgets',
            'file:///srv/git/widgets.git',
            'C:\\repos\\widgets',
            // an ssh alias: its real hostname is only in the user's ssh config
            'github-work:acme/widgets.git',
            '',
            null,
        ].forEach((remote) => assert.equal(remoteToWebUrl(remote), null, String(remote)));
    });
});

describe('repoFileUrl', () => {
    it('uses the layout of the site hosting the repo, encoding the path', () => {
        const file = 'cypress/e2e/my login.cy.js';

        assert.equal(repoFileUrl('https://github.com/acme/widgets', 'abc123', file), 'https://github.com/acme/widgets/blob/abc123/cypress/e2e/my%20login.cy.js');
        assert.equal(repoFileUrl('https://gitlab.com/group/widgets', 'abc123', file), 'https://gitlab.com/group/widgets/-/blob/abc123/cypress/e2e/my%20login.cy.js');
        assert.equal(repoFileUrl('https://gitlab.acme.com/group/widgets', 'abc123', file), 'https://gitlab.acme.com/group/widgets/-/blob/abc123/cypress/e2e/my%20login.cy.js');
        assert.equal(repoFileUrl('https://bitbucket.org/acme/widgets', 'abc123', file), 'https://bitbucket.org/acme/widgets/src/abc123/cypress/e2e/my%20login.cy.js');
        assert.equal(repoFileUrl('https://dev.azure.com/acme/project/_git/widgets', 'abc123', file), 'https://dev.azure.com/acme/project/_git/widgets?path=/cypress/e2e/my%20login.cy.js&version=GCabc123');

        // anything else (e.g. GitHub Enterprise) is assumed to be laid out like GitHub
        assert.equal(repoFileUrl('https://git.acme.com/team/widgets', 'abc123', file), 'https://git.acme.com/team/widgets/blob/abc123/cypress/e2e/my%20login.cy.js');
    });
});

describe('detectGitRepo & createSpecUrlResolver', () => {
    let repo;
    let outside;
    let commit;

    // a repo with a Cypress project in a subdirectory: <repo>/app/cypress/e2e/my login.cy.js
    const spec = 'cypress/e2e/my login.cy.js';
    const projectDir = () => repo.file('app');

    before(() => {
        repo = createTempDir({ [`app/${spec}`]: 'it("works", () => {});', 'README.md': '# widgets' });
        outside = createTempDir({ [spec]: 'it("works", () => {});' });

        git(repo.dir, 'init', '-q');
        git(repo.dir, 'add', '.');
        git(repo.dir, 'commit', '-q', '-m', 'first');
        git(repo.dir, 'remote', 'add', 'backup', 'git@gitlab.com:acme/widgets-backup.git');
        git(repo.dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
        commit = git(repo.dir, 'rev-parse', 'HEAD');
    });

    after(() => {
        repo.cleanup();
        outside.cleanup();
    });

    it('finds the repo a directory is in, preferring the origin remote', () => {
        const detected = detectGitRepo(path.join(projectDir(), 'cypress', 'e2e'));

        assert.equal(fs.realpathSync(detected.root), fs.realpathSync(repo.dir));
        assert.equal(detected.commit, commit);
        assert.equal(detected.webUrl, 'https://github.com/acme/widgets');
        assert.equal(detectGitRepo(outside.dir), null);
    });

    it('links to the spec file in the repo, at the current commit, by default (true)', () => {
        const urlFor = createSpecUrlResolver({ includeRepoPath: true, cwd: projectDir() });

        // the path is the spec file's path within the repo, not within the Cypress project
        assert.equal(urlFor(spec), `https://github.com/acme/widgets/blob/${commit}/app/cypress/e2e/my%20login.cy.js`);
    });

    it('uses another remote when there is no origin, and doesn\'t link when there are no remotes', () => {
        git(repo.dir, 'remote', 'remove', 'origin');
        assert.equal(createSpecUrlResolver({ includeRepoPath: true, cwd: projectDir() })(spec), `https://gitlab.com/acme/widgets-backup/-/blob/${commit}/app/cypress/e2e/my%20login.cy.js`);

        git(repo.dir, 'remote', 'remove', 'backup');
        assert.equal(createSpecUrlResolver({ includeRepoPath: true, cwd: projectDir() })(spec), null);

        git(repo.dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
    });

    it('doesn\'t link spec files that aren\'t in a git repo', () => {
        assert.equal(createSpecUrlResolver({ includeRepoPath: true, cwd: outside.dir })(spec), null);
    });

    it('links to the URL it is given instead, adding the spec file\'s path within the repo', () => {
        const urlFor = createSpecUrlResolver({ includeRepoPath: 'https://git.example.com/acme/widgets/blob/v1.2.3//', cwd: projectDir() });

        assert.equal(urlFor(spec), 'https://git.example.com/acme/widgets/blob/v1.2.3/app/cypress/e2e/my%20login.cy.js');
    });

    it('adds the path within the current directory to the URL it is given when the spec file isn\'t in a git repo', () => {
        const urlFor = createSpecUrlResolver({ includeRepoPath: 'https://git.example.com/acme/widgets/blob/main', cwd: outside.dir });

        assert.equal(urlFor(spec), 'https://git.example.com/acme/widgets/blob/main/cypress/e2e/my%20login.cy.js');
    });

    it('doesn\'t link when it\'s falsy, or warns and doesn\'t link when it isn\'t a web address', () => {
        [false, null, '', 0].forEach((includeRepoPath) => {
            assert.equal(createSpecUrlResolver({ includeRepoPath, cwd: projectDir() })(spec), null, String(includeRepoPath));
        });

        const warnings = [];
        const urlFor = createSpecUrlResolver({ includeRepoPath: 'git@github.com:acme/widgets.git', cwd: projectDir(), warn: (msg) => warnings.push(msg) });

        assert.equal(urlFor(spec), null);
        assert.deepEqual(warnings, ['WARNING: includeRepoPath ("git@github.com:acme/widgets.git") isn\'t a web address, so the spec files in the Allure report won\'t link anywhere.']);
    });

    it('only asks git once per directory', () => {
        const asked = [];
        const urlFor = createSpecUrlResolver({
            includeRepoPath: true,
            cwd: '/project',
            detect: (dir) => {
                asked.push(dir);
                return { root: '/project', commit: 'abc123', webUrl: 'https://github.com/acme/widgets' };
            },
        });

        assert.equal(urlFor('cypress/e2e/a.cy.js'), 'https://github.com/acme/widgets/blob/abc123/cypress/e2e/a.cy.js');
        urlFor('cypress/e2e/b.cy.js');
        urlFor('cypress/e2e/other/c.cy.js');

        assert.deepEqual(asked, [path.resolve('/project/cypress/e2e'), path.resolve('/project/cypress/e2e/other')]);
    });
});

describe('createSpecLinker', () => {
    const spec = 'cypress/e2e/login.cy.js';
    const url = 'https://github.com/acme/widgets/blob/abc123/cypress/e2e/login.cy.js';
    const anchor = (text, href = url) => `<a class="cmr-spec-link" href="${href}" target="_blank" rel="noopener noreferrer">${escapeHtml(text)}</a>`;

    it('links spec files where the report mentions them: in a thread\'s brackets, and in lists', () => {
        const link = createSpecLinker(new Map([[spec, url], ['b.cy.js', null]]));

        assert.equal(link(escapeHtml(`WARNING: Thread #1 [${spec}]: 1 test failed 1 time`)), `WARNING: Thread #1 [${anchor(spec)}]: 1 test failed 1 time`);
        assert.equal(link(escapeHtml(`couldn't be counted (${spec}, b.cy.js)`)), `couldn&#39;t be counted (${anchor(spec)}, b.cy.js)`);
        assert.equal(link(`${escapeHtml('Thread #1')}<br>${escapeHtml(spec)}`), `${escapeHtml('Thread #1')}<br>${anchor(spec)}`);
    });

    it('doesn\'t link a path that is only part of another one', () => {
        const link = createSpecLinker(new Map([[spec, url]]));
        const html = escapeHtml(`Thread #2 [other/${spec}] and [${spec}.bak]`);

        assert.equal(link(html), html);
    });

    it('links the shortened paths shown in headings, unless two spec files would share one', () => {
        // these only differ near the start, so they're shortened to the same text
        const longSpec = (team) => `cypress/e2e/${team}/a-very-long-directory-name/another-long-directory/login.cy.js`;
        const shortened = shortenPath(longSpec('one'));

        assert.notEqual(shortened, longSpec('one'));
        assert.equal(shortenPath(longSpec('two')), shortened);

        const link = createSpecLinker(new Map([[longSpec('one'), 'https://x.test/one'], [longSpec('two'), 'https://x.test/two']]));

        assert.equal(link(escapeHtml(`[${longSpec('one')}]`)), `[${anchor(longSpec('one'), 'https://x.test/one')}]`);
        assert.equal(link(escapeHtml(`[${longSpec('two')}]`)), `[${anchor(longSpec('two'), 'https://x.test/two')}]`);
        assert.equal(link(escapeHtml(`[${shortened}]`)), escapeHtml(`[${shortened}]`));

        const single = createSpecLinker(new Map([[longSpec('one'), 'https://x.test/one']]));
        assert.equal(single(escapeHtml(`[${shortened}]`)), `[${anchor(shortened, 'https://x.test/one')}]`);
    });

    it('escapes the address, and changes nothing when there\'s nothing to link', () => {
        const link = createSpecLinker(new Map([[spec, 'https://dev.azure.com/a/b/_git/c?path=/x"y&version=GCabc']]));

        assert.match(link(escapeHtml(`[${spec}]`)), /href="https:\/\/dev\.azure\.com\/a\/b\/_git\/c\?path=\/x&quot;y&amp;version=GCabc"/);
        assert.equal(createSpecLinker(new Map([[spec, null]]))('[x]'), '[x]');
    });
});
