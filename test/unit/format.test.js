const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    pluralise,
    arrToNaturalStr,
    ordinal,
    escapeHtml,
    secondsToNaturalString,
    generatePercentageBar,
    shortenPath,
} = require('../../lib/util/format');

describe('format', () => {
    it('pluralises', () => {
        assert.equal(pluralise(1, 'thread'), '1 thread');
        assert.equal(pluralise(2, 'thread'), '2 threads');
        assert.equal(pluralise(0, 'thread has', 'threads have'), '0 threads have');
    });

    it('joins arrays into natural strings, ignoring empty values', () => {
        assert.equal(arrToNaturalStr([]), '');
        assert.equal(arrToNaturalStr(['one']), 'One');
        assert.equal(arrToNaturalStr(['one', null, 'two']), 'One and two');
        assert.equal(arrToNaturalStr(['one', 'two', 'three']), 'One, two and three');
        assert.equal(arrToNaturalStr(['one', 'two'], { capitalise: false }), 'one and two');
    });

    it('writes ordinals', () => {
        assert.deepEqual([1, 2, 3, 10, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal), [
            'first', 'second', 'third', 'tenth', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th',
        ]);
    });

    it('escapes html', () => {
        assert.equal(escapeHtml('<a href="x">'), '&lt;a href&#x3D;&quot;x&quot;&gt;');
    });

    it('formats seconds', () => {
        assert.equal(secondsToNaturalString(1), '1 second');
        assert.equal(secondsToNaturalString(59), '59 seconds');
        assert.equal(secondsToNaturalString(60), '1 minute');
        assert.equal(secondsToNaturalString(61), '1 minute, 1 second');
        assert.equal(secondsToNaturalString(125), '2 minutes, 5 seconds');
    });

    it('draws a 50 character percentage bar', () => {
        const bar = generatePercentageBar(50, 30);
        assert.match(bar, /^█{25}░{25} 50\.00% \(30 seconds\)$/);
        assert.match(generatePercentageBar(100, 1), /^█{50} 100\.00%/);
    });

    it('shortens long paths at a directory boundary', () => {
        assert.equal(shortenPath('short/path.cy.js'), 'short/path.cy.js');

        const long = `${'a'.repeat(50)}/folder/another-folder/spec.cy.js`;
        const short = shortenPath(long);
        assert.ok(short.startsWith('.../'));
        assert.ok(short.endsWith('/spec.cy.js'));
        assert.ok(short.length <= 60);
    });
});
