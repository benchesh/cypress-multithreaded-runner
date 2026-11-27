// One test fails all 4 of its attempts (it's retried 3 times), so the spec file fails. It only passes when the
// runner re-runs the spec file (see retryAllFailedSpecs)

import { visitTestDomain } from '../../support/testDomain';
import { failOnFirstRuns } from '../../support/runCount';

describe('Spec retry', { retries: { runMode: 3 } }, () => {
    beforeEach(() => {
        visitTestDomain();
    });

    it('only passes when the spec file is retried', () => {
        failOnFirstRuns(4);
    });

    it('passes every time', () => {
        expect(1).to.equal(1);
    });
});
