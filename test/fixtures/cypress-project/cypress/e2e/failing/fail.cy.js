describe('Failing suite', () => {
    it('passes', () => {
        expect(1).to.equal(1);
    });

    // retried 3 times, so it fails 4 times in total
    it('fails', { retries: { runMode: 3 } }, () => {
        expect(1).to.equal(2);
    });
});
