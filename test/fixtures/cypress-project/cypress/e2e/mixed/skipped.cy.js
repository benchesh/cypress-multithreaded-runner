import { visitTestDomain } from '../../support/testDomain';

describe('Skipped', { retries: { runMode: 3 } }, () => {
    beforeEach(() => {
        visitTestDomain();
    });

    it.skip('is skipped with it.skip', () => {});

    xit('is skipped with xit', () => {});

    it('has no callback');

    describe.skip('a skipped suite', () => {
        it('is skipped with its suite 1', () => {});
        it('is skipped with its suite 2', () => {});
    });

    it('skips itself at runtime', function () {
        this.skip();
    });

    it('passes', () => {
        expect(1).to.equal(1);
    });
});
