const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createGrepMatcher, parseFullTitleGrep, parseTagsGrep } = require('../../lib/discovery/grep');

// @cypress/grep's own implementation, to check the port stays in sync
// (its package exports don't expose utils, so it's required by path)
const cypressGrepUtils = require(path.join(path.dirname(require.resolve('@cypress/grep')), 'utils.js'));

const TITLE_GREPS = ['', 'login', '-login', 'login; logout', 'login;-admin', '-admin;-guest', '  spaced  '];
const TAG_GREPS = ['', '@smoke', '@smoke @slow', '@smoke+@slow', '@smoke+-@slow', '-@slow', '--@slow', '@smoke --@slow', '@a,@b'];
const TESTS = [
    { name: 'Suite login works', tags: ['@smoke'] },
    { name: 'Suite logout works', tags: ['@smoke', '@slow'] },
    { name: 'Admin login', tags: ['@slow'] },
    { name: 'guest page', tags: [] },
    { name: 'spaced title', tags: ['@a'] },
];

describe('grep', () => {
    it('parses title greps the same way as @cypress/grep', () => {
        TITLE_GREPS.forEach((grep) => assert.deepEqual(parseFullTitleGrep(grep), cypressGrepUtils.parseFullTitleGrep(grep), grep));
    });

    it('parses tag greps the same way as @cypress/grep', () => {
        TAG_GREPS.forEach((grep) => assert.deepEqual(parseTagsGrep(grep), cypressGrepUtils.parseTagsGrep(grep), grep));
    });

    it('selects the same tests as @cypress/grep', () => {
        TITLE_GREPS.forEach((grep) => {
            TAG_GREPS.forEach((grepTags) => {
                const matcher = createGrepMatcher({ grep, grepTags });
                const parsed = cypressGrepUtils.parseGrep(grep, grepTags);

                TESTS.forEach(({ name, tags }) => {
                    assert.equal(matcher(name, tags), cypressGrepUtils.shouldTestRun(parsed, name, tags, false), `grep "${grep}", grepTags "${grepTags}", test "${name}"`);
                });
            });
        });
    });

    it('supports grepUntagged', () => {
        const matcher = createGrepMatcher({ grepUntagged: true });

        assert.equal(matcher('anything', []), true);
        assert.equal(matcher('anything', ['@smoke']), false);
    });

    it('strips the quotes the runner adds to env values', () => {
        const matcher = createGrepMatcher({ grepTags: '"@smoke"', grepUntagged: '"false"' });

        assert.equal(matcher('x', ['@smoke']), true);
        assert.equal(matcher('x', ['@slow']), false);
    });
});
