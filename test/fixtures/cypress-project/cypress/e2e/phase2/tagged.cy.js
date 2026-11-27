describe('Tagged', { tags: '@smoke' }, () => {
    it('smoke only', () => {
        expect(1).to.equal(1);
    });

    it('smoke and slow', { tags: ['@slow'] }, () => {
        expect(1).to.equal(1);
    });
});

describe('Untagged', () => {
    it('no tags', () => {
        expect(1).to.equal(1);
    });
});
