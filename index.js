const { importAll } = require('./lib/importAll.js');
importAll().from('./common.js');

const { execSync } = require('child_process');

const runCmr = (config) => {
  execSync(`node -e 'const scr=require("${__dirname}/async");scr(${JSON.stringify(
    config,
  )});'`, {
    stdio: [null, process.stdout, process.stderr],
  });
};

module.exports = (config = {}) => {
  const fullConfig = getFullConfig(config);

  const maxConcurrentThreadsExperiment = fullConfig.maxConcurrentThreadsExperiment;

  if (!maxConcurrentThreadsExperiment) {
    runCmr(fullConfig);
    return;
  }

  const maxConcurrentThreadsArray = maxConcurrentThreadsExperiment.maxConcurrentThreadsArray;

  if (!maxConcurrentThreadsExperiment.maxConcurrentThreads.length) {
    process.exit(1);
  }

  const repeat = maxConcurrentThreadsExperiment.repeat ?? 3;

  console.log(`Max concurrent threads experiment is active.\n\nAll experiments will be wrapped in a try/catch.\nMax concurrent threads array: ${maxConcurrentThreadsArray}\nEach experiment will run ${repeat} time(s)\n`);

  const experimentArr = [];

  maxConcurrentThreadsArray.forEach(maxConcurrentThreads => {
    console.log(`Start of ${maxConcurrentThreads} max concurrent threads experiment(s)`);
    experimentArr.push([]);

    for (let i = 0; i < repeat; i++) {
      experimentArr[experimentArr.length - 1].push(performance.now());

      try {
        runCmr({
          ...fullConfig,
          maxConcurrentThreadsExperiment: false,
          maxConcurrentThreads,
          saveThreadBenchmark: false,
          generateAllure: false,
        });
      } catch (e) { }

      experimentArr[experimentArr.length - 1][i] = timeDifference(performance.now(), experimentArr[experimentArr.length - 1][i]);
    }
  });

  let longestExperiment = -1;
  let shortestExperiment = experimentArr[0][0];

  experimentArr.forEach((arr) => {
    arr.forEach((experiment) => {
      if (experiment > longestExperiment) {
        longestExperiment = experiment;
      }
      if (experiment < shortestExperiment) {
        shortestExperiment = experiment;
      }
    });
  });

  let experimentResultsStr = '';

  maxConcurrentThreadsArray.forEach((maxConcurrentThreads, index) => {
    experimentResultsStr += `${maxConcurrentThreads} max concurrent thread(s):\n`;

    experimentArr[index].forEach((experimentTime, expIndex) => {
      const percentageOfTotal = (
        experimentTime / longestExperiment
      ) * 100;

      experimentResultsStr += `Experiment #${expIndex + 1}: ${generatePercentageBar(percentageOfTotal, experimentTime)}\n\n`;
    });
  });

  console.log(`\nMax concurrent threads experiment results:\n\n${experimentResultsStr}`);
};

