import { failOnFirstRuns } from '../../../support/runCount';

// Fails the first time it runs, then passes when retryAllFailedSpecs re-runs it
describe('Phase 2 spec C', () => {
    it('fails on the first run only', () => {
        failOnFirstRuns(1);
    });
});
