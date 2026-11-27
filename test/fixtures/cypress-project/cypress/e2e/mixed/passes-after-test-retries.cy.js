// Every test passes in the end, but one only does so on its third attempt (it's retried twice)

import { visitTestDomain } from '../../support/testDomain';

let attempts = 0;

describe('Test retries', { retries: { runMode: 3 } }, () => {
    beforeEach(() => {
        visitTestDomain();
    });

    it('passes first time', () => {
        expect(1).to.equal(1);
    });

    it('is retried twice before it passes', () => {
        attempts++;
        expect(attempts, 'attempt').to.equal(3);
    });
});
