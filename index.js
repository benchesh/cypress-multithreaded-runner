const { importAll } = require('./lib/importAll.js');
importAll().from('./common.js');

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

const runCmr = (config) => {
  execSync(`node -e 'const scr=require("${__dirname}/async");scr(${JSON.stringify(
    config,
  )});'`, {
    stdio: [null, process.stdout, process.stderr],
  });
};

const getAllFilesAndDirs = (srcpath) => (
  fs.existsSync(srcpath) ? fs.readdirSync(srcpath).map(src => path.resolve(srcpath, src)) : []
);

module.exports = (config = {}) => {
  const fullConfig = getFullConfig(config);

  const maxConcurrentThreadsExperiment = fullConfig.maxConcurrentThreadsExperiment;

  if (!maxConcurrentThreadsExperiment) {
    try {
      runCmr(fullConfig);
    } catch (err) {
      process.exit(1);// exits in the same manner as async mode would
    }
    return;
  }

  const maxConcurrentThreadsArray = maxConcurrentThreadsExperiment.maxConcurrentThreadsArray;

  if (!maxConcurrentThreadsExperiment.maxConcurrentThreadsArray.length) {
    process.exit(1);
  }

  const repeat = maxConcurrentThreadsExperiment.repeat ?? 3;

  console.log(`Max concurrent threads experiment is active.\n\nAll experiments will be wrapped in a try/catch.\nMax concurrent threads array: ${maxConcurrentThreadsArray}\nEach experiment will run ${repeat} time(s)\n`);

  const experimentArr = [];

  const ignorePaths = [];

  maxConcurrentThreadsArray.forEach((maxConcurrentThreads, threadArrIndex) => {
    console.log(`Start of ${maxConcurrentThreads} max concurrent threads experiment(s)`);
    experimentArr.push([]);

    for (let i = 0; i < repeat; i++) {
      const firstRun = !i && !threadArrIndex;

      experimentArr[experimentArr.length - 1].push({
        timeTaken: performance.now(),
        timeStarted: (new Date()),
        summary: '',
        cmreAllureDirRel: `cmre_${maxConcurrentThreads}_${i}_allure-report`,
        cmreDirAbs: path.resolve(fullConfig.reportDir, `cmre_${maxConcurrentThreads}_${i}`),
        cmreAllureDirAbs: path.resolve(fullConfig.reportDir, `cmre_${maxConcurrentThreads}_${i}_allure-report`)
      });

      try {
        runCmr({
          ...fullConfig,
          allureReportDir: null,
          clean: fullConfig.clean && firstRun,
          maxConcurrentThreadsExperimentInProg: true,
          maxConcurrentThreads,
          saveThreadBenchmark: false,
          browserStackTestObservabilityUpload: false,
          overwriteAllureHistory: false,
        });
      } catch (e) { }

      experimentArr[experimentArr.length - 1][i].timeTaken = calcTimeDifference(performance.now(), experimentArr[experimentArr.length - 1][i].timeTaken);

      experimentArr[experimentArr.length - 1][i].timeFinished = (new Date());

      const threadPerfSummary = path.join(fullConfig.reportDir, 'thread-performance-summary.txt');

      if (fs.existsSync(threadPerfSummary)) {
        experimentArr[experimentArr.length - 1][i].summary = fs.readFileSync(threadPerfSummary).toString('utf8');
      }

      ignorePaths.push(experimentArr[experimentArr.length - 1][i].cmreDirAbs);
      ignorePaths.push(experimentArr[experimentArr.length - 1][i].cmreAllureDirAbs);

      getAllFilesAndDirs(fullConfig.reportDir).forEach((src) => {
        if (!ignorePaths.includes(src)) {
          if (path.basename(src) === 'allure-report') {
            fs.moveSync(
              src,
              path.join(experimentArr[experimentArr.length - 1][i].cmreAllureDirAbs),
              { overwrite: true }
            )
          } else {
            fs.moveSync(
              src,
              path.join(experimentArr[experimentArr.length - 1][i].cmreDirAbs, path.basename(src)),
              { overwrite: true }
            )
          }
        }
      })
    }
  });

  let longestExperiment = -1;
  // let shortestExperiment = experimentArr[0][0].timeTaken;

  experimentArr.forEach((arr) => {
    arr.forEach((experiment) => {
      if (experiment.timeTaken > longestExperiment) {
        longestExperiment = experiment.timeTaken;
      }
      // if (experiment < shortestExperiment) {
      //   shortestExperiment = experiment.timeTaken;
      // }
    });
  });

  let experimentResultsStr = `\n${fullConfig.allureReportHeading}\n\nMax concurrent threads experiment results:\n\n`;
  let experimentResultsHTML = `<!DOCTYPE html>
<html>
<head>
   <meta charset="utf-8">
   <title>Cypress Multithreaded Runner - Max concurrent threads experiment results</title>
</head>
<body style="margin:0;">
  <pre style="padding:15px;margin:0;">${experimentResultsStr}`;

  maxConcurrentThreadsArray.forEach((maxConcurrentThreads, index) => {
    const heading = `===========================\n${maxConcurrentThreads} max concurrent thread(s):\n===========================\n`;
    experimentResultsStr += heading;
    experimentResultsHTML += heading;

    experimentArr[index].forEach((experiment, expIndex) => {
      const percentageOfTotal = (
        experiment.timeTaken / longestExperiment
      ) * 100;

      const strAppend = (html) => {
        const getAllureUrl = () => {
          if (fs.existsSync(path.join(experiment.cmreAllureDirAbs, 'complete.html'))) {
            return path.join(experiment.cmreAllureDirRel, 'complete.html');
          }

          return path.join(experiment.cmreAllureDirRel, 'index.html')
        }

        return `${html ? `<a href="./${getAllureUrl()}">` : ''}Experiment #${expIndex + 1}${html ? `</a>` : ''}: ${generatePercentageBar(percentageOfTotal, experiment.timeTaken)}\n${experiment.summary}\nStarted: ${experiment.timeStarted}\nFinished: ${experiment.timeFinished}\n\n`
      }

      experimentResultsStr += strAppend();
      experimentResultsHTML += strAppend(fullConfig.generateAllure);
    });
  });

  if (fullConfig.generateAllure) {
    experimentResultsHTML += 'The Allure reports can be accessed at the links above';
  }

  experimentResultsHTML += `</pre>
</body>
</html>`;

  console.log(experimentResultsStr);

  let experimentResultsHTMLpath = path.resolve(fullConfig.reportDir, 'index.html');

  fs.writeFileSync(experimentResultsHTMLpath, experimentResultsHTML);

  if (fullConfig.allureReportDir !== fullConfig.defaultAllureReportDir) {
    getAllFilesAndDirs(fullConfig.reportDir).forEach((src) => {
      if (path.basename(src).includes('allure-report') || path.basename(src) === 'index.html') {
        fs.moveSync(
          src,
          path.resolve(fullConfig.allureReportDir, path.basename(src)),
          { overwrite: true },
        );
      }
    });

    experimentResultsHTMLpath = path.resolve(fullConfig.allureReportDir, 'index.html');
  }

  console.log(green(`The HTML report for these experiments ${fullConfig.generateAllure ? '(including all Allure reports) ' : ''}can be accessed at: "${experimentResultsHTMLpath}"`));

  if (fullConfig.openAllure) {
    const runShellCommand = (cmd) => {
      execSync(cmd, {
        stdio: [null, process.stdout, process.stderr]
      });
    };

    runShellCommand(`open "${experimentResultsHTMLpath}"`)
  } else {
    console.log('Passing through the arg --open will open the HTML report as soon as the tests have finished running');
  }
};

