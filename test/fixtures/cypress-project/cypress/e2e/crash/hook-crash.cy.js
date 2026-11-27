describe('Hook crash', () => {
    before(() => {
        throw new Error('before hook exploded');
    });

    it('never runs 1', () => {});
    it('never runs 2', () => {});
});
