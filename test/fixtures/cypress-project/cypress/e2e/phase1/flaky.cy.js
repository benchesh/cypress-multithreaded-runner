let attempts = 0;

describe('Flaky suite', () => {
    it('passes on the second attempt', { retries: { runMode: 2 } }, () => {
        attempts++;
        expect(attempts).to.be.greaterThan(1);
    });
});
