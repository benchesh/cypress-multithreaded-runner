# cypress-multithreaded-runner

A lightweight method to run Cypress spec files in multiple threads, with built-in support for Allure report generation.

Out of the box, Cypress will only run your spec files in a single thread. It also won't create any kind of easy-to-read report once the tests have completed. By making use of this module, you'll be able to adapt your Cypress project to run much faster than before, while also generating a comprehensive Allure report for every run.

## Dependencies

- [node 18 or above](https://nodejs.org/en/download)
- A [Cypress](https://www.npmjs.com/package/cypress) project (tested on version `12.10`)
- [pip](https://pypi.org/project/pip/) (optional: only needed if you wish to combine the Allure report into a single file)
- [@cypress/grep](https://www.npmjs.com/package/@cypress/grep) (optional: only needed if you want to use Cypress grep features)

## Setup

In its current form, you can import the runner into a simple node application, initialising it like so:

```javascript
const runner = require("cypress-multithreaded-runner");

const cypressConfigOverride = {
  reportDir: "put-the-reports-here",
};

runner({
  cypressConfig: {
    filepath: "src/cypress/configurations/my-generic-cypress.config.js",
    object: cypressConfigOverride,
  },
  grep: "my-test",
  grepTags: "my-tag",
  allureReportDir: "i-would-rather-save-the-allure-report-here",
  reportDir: cypressConfigOverride.reportDir,
  specsDir: "src/cypress/tests",
  waitForFileExist: {
    filepath: "a-file-that-I-expect-to-exist-before-subsequent-threads-run.txt",
    timeout: 60,
    deleteAfterCompletion: true,
  },
  threadDelay: 10,
});
```

A thread will be created for every top-level directory within your tests directory (`specsDir`). For example, 8 top-level folders will be 8 threads. Each subsequent thread after the first will be started 10 seconds after the previous one (`threadDelay` can change this).

### Optional: Grep

If you want to make use of [@cypress/grep](https://www.npmjs.com/package/@cypress/grep), add it as a dependency to your project and follow the [official readme](https://github.com/cypress-io/cypress/tree/develop/npm/grep#readme) to see how to import it. Refer to the [options table](#options) to see what features are supported by cypress-multithreaded-runner out of the box.

### Optional: Allure report

To generate Allure reports, you will need to add the following import to your [support file](https://on.cypress.io/writing-and-organizing-tests#Support-file):

```javascript
import "cypress-multithreaded-runner/allure";
```

In addition, add the following import to your [config file](https://docs.cypress.io/guides/references/configuration#setupNodeEvents):

```javascript
const allureWriter = require("cypress-multithreaded-runner/allure/writer");

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      allureWriter(on, config);
      return config;
    },
  },
});
```

The imports above are simple wrappers for [@shelex/cypress-allure-plugin](https://www.npmjs.com/package/@shelex/cypress-allure-plugin), so refer to that module's readme should you wish to customise the plugin's behaviour.

If either of the imports are missing, you may find that an empty Allure report is generated after running tests.

### Guidance

Pay attention to the performance of each thread when adding a new test. It is a good idea to try making the accumulation of tests in each thread take roughly the same amount of time to finish running, as any thread that takes significantly longer than the others will be a bottleneck! Therefore, try to add any new tests to threads which aren't oversaturated. You can have a look at how each thread is performing by viewing the "Thread Performance Summary" & other logs, all of which will be added to the bottom of the Allure report as well as in separate text files.

Diminishing returns will be observable the more threads you add, as most computers have a relatively low number of threads that can be actively used at any given time. When too many threads are added you may notice a large increase in the frequency of failing tests, and you may also actually notice that other threads are just running slower in general. It's all a bit of a balancing act if you want to get it all just right.

None of the Cypress threads can "talk" to each other, so your project may need a bit of extra configuration if this is needed. For example, let's say your first thread logs in to a website and you'd like this session to be maintained across your other threads. You could have the first Cypress thread log in and then save a file containing all of the cookies that the other threads need. You can make use of the `waitForFileExist` option to help make such functionality possible for your project. [cypress-wordpress-session](https://www.npmjs.com/package/cypress-wordpress-session) is an example of a Cypress addon that can be used to create & load a cookies file for a persistent session across multiple threads.

### Overriding options in the command line

The module makes use of `argv` to allow options to be overriden via the command line. Arguments passed in via the command line will take precedence over any options set via your node application. For example, let's say you want to override the `reportDir` option. You can run your node application with a standard kebab-case argument (eg. `--report-dir="my-report-dir"`) and the `reportDir` will be overriden.

## Options

| Name                       | Type             | Default value               | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ---------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cypressConfig`            | object           | null                        | The config that'll be passed through to every Cypress instance. For specific options, see the [table below](#cypressconfig).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `reportDir`                | string           | null                        | The location to save the full report to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `allureReportDir`          | string           | `<reportDir>/allure-report` | A different location to save the Allure report, specifically                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `specsDir`                 | string           | null                        | The top-level directory containing all Cypress spec files are                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `openAllure`               | boolean          | false                       | Open the Allure report after it's generated.<br>If `combineAllure` is also passed in, it'll open the combined Allure report instead.<br>If `hostAllure` is also passed in, `openAllure` will be ignored.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `open`                     | boolean          | false                       | Alias for `openAllure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `combineAllure`            | boolean          | false                       | Combine the Allure report into a single file (complete.html). Requires [pip](https://pypi.org/project/pip/) to be installed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `combine`                  | boolean          | false                       | Alias for `combineAllure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `hostAllure`               | boolean          | false                       | Spin up a localhost for the Allure report after it's generated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `host`                     | boolean          | false                       | Alias for `hostAllure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ignoreCliOverrides`       | arrayOf(string)  | null                        | A list of keys of properties that you don't want the CLI to override when you run an instance of cypress-multithreaded-runner. This will enable your node app to do a custom override of that uses a combination of the CLI and itself. See [here](#ignoreclioverrides-example) for an example                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `logMode`                  | oneOf([1,2,3,4]) | 1                           | The method by which you want each Cypress thread to print logs to the console.<br><br>`1`: Only print logs from one thread at a time, in chronological order. Only when the first thread completes will the logs from the second thread be printed, and so on.<br>`2`: Only print logs from one thread at a time, but allow non-chronology. Should any other thread complete before the current one does, these logs will be "queued" and then print when the first one completes. For example, let's say thread 3 completes before thread 1 completes. In this scenario, you can expect to see all of the output for thread 1, then all of thread 3, then thread 2.<br>`3`: Print any log from any thread as soon as it manifests. This will likely mean that you see a mix of logs from each thread, and can be difficult to understand the continuity in the logs the more threads you have.<br>`4`: Identical to mode `3`, except that when all threads complete, print all logs again but separate out all of the threads. |
| `waitForFileExist`         | object           | null                        | Wait for a specific file to exist (and larger than 0 bytes in size) before subsequent threads begin. For specific options, see the [table below](#waitforfileexist).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `maxThreadRestarts`        | number           | 5                           | Should an instance of Cypress crash, it may be restarted up to this many times until all threads complete successfully. Note that any spec file that fails in a `beforeEach` hook will be considered a crash. This behaviour may be amended in a future version of this module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `threadDelay`              | number           | 30                          | The amount seconds to wait before starting the next thread, unless the current Cypress instance has already started running. If `waitForFileExist` has been set, the 2nd thread will continue waiting until the given file exists. For more info, see the [table below](#waitforfileexist).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `alwaysWaitForThreadDelay` | boolean          | false                       | Always wait for the total `threadDelay` time to elapse before starting the next thread, even if the current Cypress instance has started running                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `threadTimeout`            | number           | 600                         | The maximum amount of seconds to wait for a thread to respond before it's considered a crash. Every time any thread logs something, the timeout will be reset. Set to 0 to have no timeout at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `grep`                     | string           | null                        | `grep` arg to be passed through as an environment variable to each Cypress instance. See [here](https://www.npmjs.com/package/@cypress/grep) for more information.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `grepTags`                 | string           | null                        | `grepTags` arg to be passed through as an environment variable to each Cypress instance. See [here](https://www.npmjs.com/package/@cypress/grep) for more information.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `grepUntagged`             | boolean          | false                       | `grepUntagged` arg to be passed through as an environment variable to each Cypress instance. See [here](https://www.npmjs.com/package/@cypress/grep) for more information.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `passthroughEnvArgs`       | string           | null                        | Additional Cypress environment arguments to be passed through to each Cypress instance. No preprocessing will be done to this string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### cypressConfig

| Name       | Type   | Default value | Description                                                                                                                        |
| ---------- | ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `filepath` | string | null          | A config file to be passed through to every Cypress instance                                                                       |
| `object`   | object | null          | A config object to be passed through to every Cypress instance. Any overlapping options will override those set via the `filepath` |

### waitForFileExist

| Name                                  | Type    | Default value | Description                                                                                                                                                                                                            |
| ------------------------------------- | ------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filepath`                            | string  | null          | The file you wish all threads except the first one to wait for                                                                                                                                                         |
| `minSize`                             | number  | 2             | The minimum acceptable size (in bytes) for the file. Default is therefore 2 bytes. A null file will be 0 bytes.<br>If the file exists but has a size smaller than this value, it'll be treated as if it doesn't exist. |
| `timeout`                             | number  | 60            | The maximum amount of seconds to wait for the file to exist. The threads will begin when the time elapses, regardless of whether the file exists or not.                                                               |
| `deleteAfterCompletion`               | boolean | false         | Delete the file once all threads have completed                                                                                                                                                                        |
| `stopWaitingWhenFirstThreadCompletes` | boolean | true          | When set to true (recommended), subsequent threads will start running when the first thread completes, even if the file doesn't exist.                                                                                 |

### ignoreCliOverrides example

Let's say in your node app, you want your instance of cypress-multithreaded-runner to always include a specific tag for `grepTags` (`@tag1`), like so:

```javascript
const runner = require("cypress-multithreaded-runner");

const cypressConfigOverride = {
  reportDir: "put-the-reports-here",
};

runner({
  cypressConfig: {
    filepath: "src/cypress/configurations/my-generic-cypress.config.js",
    object: cypressConfigOverride,
  },
  reportDir: cypressConfigOverride.reportDir,
  specsDir: "src/cypress/tests",
  grepTags: "@tag1",
});
```

However, if you then run your app in the command line with argument `--grepTags="@tag2"`, the `grepTags` value will be set to `@tag2` instead. By making use of `ignoreCliOverrides` (as well as [yargs](https://www.npmjs.com/package/yargs)) you can write your own function to combine both of these values for `grepTags`:

```javascript
const runner = require("cypress-multithreaded-runner");

const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const { argv } = yargs(hideBin(process.argv));

const grepTags = [argv.grepTags, "@tag1"].filter((str) => str).join(" ");

const cypressConfigOverride = {
  reportDir: "put-the-reports-here",
};

runner({
  cypressConfig: {
    filepath: "src/cypress/configurations/my-generic-cypress.config.js",
    object: cypressConfigOverride,
  },
  reportDir: cypressConfigOverride.reportDir,
  specsDir: "src/cypress/tests",
  grepTags,
  ignoreCliOverrides: ["grepTags"],
});
```

As you've now instructed cypress-multithreaded-runner to not overwrite the `grepTags` value with the command line argument, the above code would make the `grepTags` value equal to `@tag2 @tag1` when you run your app with the argument `--grepTags="@tag2"`.
