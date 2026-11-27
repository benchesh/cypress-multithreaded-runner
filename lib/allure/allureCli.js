// Running the Allure command line tool

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const isWindows = process.platform.startsWith('win');

/**
 * The allure-commandline executable (referenced directly due to https://github.com/allure-framework/allure-npm/issues/30)
 */
const allureExecutable = () => path.resolve(
    path.dirname(require.resolve('allure-commandline')),
    'dist',
    'bin',
    `allure${isWindows ? '.bat' : ''}`,
);

const isJavaInstalled = () => {
    const result = spawnSync('java', ['-version'], { stdio: 'ignore', shell: isWindows });
    return result.status === 0;
};

const runAllure = (args, { cwd, onOutput = () => { }, onError = (str) => console.log(str) }) => new Promise((resolve) => {
    const child = spawn(allureExecutable(), args, { cwd, shell: isWindows });

    child.stdout.on('data', (data) => onOutput(data.toString()));
    child.stderr.on('data', (data) => onError(data.toString()));
    child.on('error', (err) => {
        onError(`Failed to run Allure: ${err.message}`);
        resolve(1);
    });
    child.on('close', resolve);
});

/**
 * Generate the Allure report (and optionally a single-file version) from <reportDir>/allure-results
 *
 * @param {object} options
 * @param {string} options.reportDir
 * @param {boolean} options.combine also generate a single-file report into allure-report-temp
 * @param {(str: string) => void} [options.verboseLog]
 */
const generateAllureReport = async ({ reportDir, combine, verboseLog = () => { } }) => {
    process.stdout.write('Generating report...');

    const run = (outputDir, extraArgs = []) => runAllure(
        ['generate', 'allure-results', '--clean', '-o', outputDir, ...extraArgs],
        { cwd: reportDir, onOutput: verboseLog },
    );

    await Promise.all([
        run('allure-report'),
        combine ? run('allure-report-temp', ['--single-file']) : null,
    ]);

    process.stdout.write(' done\n');
};

/**
 * Serve the Allure report on a local web server (blocks until the server is stopped)
 */
const hostAllureReport = (allureReportDir) => runAllure(['open', allureReportDir], {
    cwd: path.dirname(allureReportDir),
    onOutput: (str) => process.stdout.write(str),
});

module.exports = {
    generateAllureReport,
    hostAllureReport,
    isJavaInstalled,
};
