describe('Passing suite', () => {
    it('passes first', () => {
        expect(1).to.equal(1);
    });

    describe('nested', () => {
        it('passes nested', () => {
            expect(true).to.equal(true);
        });
    });
});
