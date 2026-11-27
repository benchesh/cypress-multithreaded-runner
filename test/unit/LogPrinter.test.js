const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { LogPrinter } = require('../../lib/threads/LogPrinter');
const { Thread } = require('../../lib/threads/Thread');

const setup = (logMode, threadCount = 3) => {
    const written = [];
    const announcements = [];
    const printer = new LogPrinter({ logMode, write: (str) => written.push(str), log: (str) => announcements.push(str) });
    const threads = Array.from({ length: threadCount }, (_, i) => new Thread({ threadNo: i + 1, phase: { phaseNo: 1 }, spec: `${i + 1}.cy.js` }));

    printer.track(threads);

    const output = (threadNo, chunk) => {
        threads[threadNo - 1].appendLog(chunk);
        printer.output(threads[threadNo - 1], chunk);
    };

    return { printer, threads, written, announcements, output, text: () => written.join('') };
};

describe('LogPrinter', () => {
    it('logMode 1 prints one thread at a time, in thread order', () => {
        const { printer, threads, output, text } = setup(1);

        output(1, 'a1 ');
        output(2, 'b1 ');
        output(3, 'c1 ');
        printer.finished(threads[2]); // #3 finishes first, but must wait for #2
        output(1, 'a2 ');
        printer.finished(threads[0]);
        output(2, 'b2 ');
        printer.finished(threads[1]);

        assert.equal(text(), 'a1 a2 b1 b2 c1 ');
    });

    it('logMode 2 prints threads that finished early as soon as the current thread completes', () => {
        const { printer, threads, output, text } = setup(2);

        output(1, 'a1 ');
        output(2, 'b1 ');
        output(3, 'c1 ');
        printer.finished(threads[2]);
        printer.finished(threads[0]);
        output(2, 'b2 ');
        printer.finished(threads[1]);

        assert.equal(text(), 'a1 c1 b1 b2 ');
    });

    it('logMode 3 prints everything immediately', () => {
        const { output, text } = setup(3);

        output(1, 'a1 ');
        output(2, 'b1 ');
        output(1, 'a2 ');

        assert.equal(text(), 'a1 b1 a2 ');
    });

    it('logMode 4 also prints each thread separately at the end', () => {
        const { printer, threads, output, text } = setup(4, 2);

        output(1, 'a1 ');
        output(2, 'b1 ');
        output(1, 'a2 ');
        printer.printAllSeparately(threads);

        assert.equal(text(), 'a1 b1 a2 a1 a2 b1 ');
    });

    it('does not wait for threads that will never run', () => {
        const { printer, threads, output, text } = setup(1);

        output(1, 'a ');
        output(3, 'c ');
        printer.skip(threads[1]);
        printer.finished(threads[0]);
        printer.finished(threads[2]);

        assert.equal(text(), 'a c ');
    });

    it('flushes queued logs before a retry', () => {
        const { printer, threads, output, text } = setup(1, 2);

        output(1, 'a ');
        output(2, 'b ');
        printer.finished(threads[1]);
        printer.flushAll();

        assert.equal(text(), 'a b ');
    });

    it('announces when a thread starts', () => {
        const { printer, threads, announcements } = setup(1);

        printer.announceStart(threads[0], 1);
        printer.announceStart(threads[1], 2);

        assert.deepEqual(announcements, [
            'Thread #1 is now starting...',
            'Thread #2 is now starting, and its logs will be printed when all preceding threads have completed.',
        ]);
    });
});
