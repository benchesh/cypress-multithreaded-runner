import { failOnFirstRuns } from '../../support/runCount';

// Fails the first time the spec runs, then passes on subsequent runs
describe('Retry once', () => {
    it('fails on the first run only', () => {
        failOnFirstRuns(1);
    });

    it('always passes', () => {
        expect(1).to.equal(1);
    });
});
