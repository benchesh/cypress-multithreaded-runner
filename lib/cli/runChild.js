// Entry point for the child process used by the synchronous API (index.js).
// The merged config arrives as JSON on stdin

const { run } = require('../run');

let input = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
    input += chunk;
});
process.stdin.on('end', async () => {
    try {
        await run(JSON.parse(input));
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
});
