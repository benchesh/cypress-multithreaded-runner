// Titles that allure-cypress tidies up in its results: without spaces at either end, repeated spaces or Allure metadata
describe('Titles', () => {
    ['draft', 'pending'].forEach((status) => {
        it(`created as a ${status} ${status === 'pending' ? 'review' : ''}`, () => {});
    });

    it('  has   extra spaces ', () => {});

    it('has Allure metadata @allure.id:123 @allure.label.owner:someone', () => {});
});
