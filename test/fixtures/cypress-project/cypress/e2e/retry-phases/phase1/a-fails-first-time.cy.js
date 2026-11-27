import { failOnFirstRuns } from '../../../support/runCount';

// Fails the first time it runs, then passes when retryAllFailedSpecs re-runs it
describe('Phase 1 spec A', () => {
    it('fails on the first run only', () => {
        failOnFirstRuns(1);
    });
});
