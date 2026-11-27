// Each test is retried up to 3 times (4 attempts). Attempts are counted per test within the spec run
const attempts = {};
const attempt = (name) => {
    attempts[name] = (attempts[name] || 0) + 1;
    return attempts[name];
};

describe('Retries', { retries: { runMode: 3 } }, () => {
    it('fails every attempt', () => {
        expect(attempt('every'), 'attempt').to.equal(99);
    });

    it('passes on the fourth attempt', () => {
        expect(attempt('fourth'), 'attempt').to.equal(4);
    });

    it('passes on the second attempt', () => {
        expect(attempt('second'), 'attempt').to.equal(2);
    });
});
