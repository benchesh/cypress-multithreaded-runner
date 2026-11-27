// Cypress treats an error in a before hook as a crash, so the runner restarts the thread (see maxThreadRestarts).
// This spec file crashes the first 2 times it runs, then passes on the third

import { visitTestDomain } from '../../support/testDomain';
import { countRuns } from '../../support/runCount';

describe('Crashes', { retries: { runMode: 3 } }, () => {
    before(() => {
        countRuns('crash').then((runNo) => {
            if (runNo <= 2) {
                throw new Error(`Cypress crashed (run ${runNo})`);
            }
        });
    });

    beforeEach(() => {
        visitTestDomain();
    });

    it('runs once Cypress stops crashing', () => {
        expect(1).to.equal(1);
    });

    it('also runs once Cypress stops crashing', () => {
        expect(1).to.equal(1);
    });
});
