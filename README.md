# cypress-multithreaded-runner

A lightweight method to run Cypress spec files in multiple threads, with built-in support for Allure report generation.

Out of the box, Cypress will only run your spec files in a single thread. It also won't create any kind of easy-to-read report once the tests have completed. By making use of this module, you'll be able to adapt your Cypress project to run much faster than before, while also generating a comprehensive Allure report for every run.

## Dependencies

- node 18 or above
- A Cypress project (tested on version `12.10`)
- pip (optional: only needed if you wish to combine the Allure report into a single file)

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
  allureReportDir: "i-would-rather-save-the-allure-report-here",
  reportDir: cypressConfigOverride.reportDir,
  specsDir: "src/cypress/tests",
  waitForFileExist: {
    filepath: "a-file-that-I-expect-to-exist-before-subsequent-threads-run.txt",
    timeout: 60,
    deleteAfterCompletion: true,
  },
});
```

A thread will be created for every top-level directory within your tests directory (`specsDir`). For example, 8 top-level folders will be 8 threads. Each subsequent thread after the first will be started 5 seconds after the previous one.

### Guidance

Pay attention to the performance of each thread when adding a new test. It is a good idea to try making the accumulation of tests in each thread take roughly the same amount of time to finish running, as any thread that takes significantly longer than the others will be a bottleneck! Therefore, try to add any new tests to threads which aren't oversaturated. You can have a look at how each thread is performing by viewing the "Thread Performance Summary" & other logs, all of which will be added to the bottom of the Allure report as well as in separate text files.

Diminishing returns will be observable the more threads you add, as most computers have a relatively low number of threads that can be actively used at any given time. When too many threads are added you may notice a large increase in the frequency of failing tests, and you may also actually notice that other threads are just running slower in general. It's all a bit of a balancing act if you want to get it all just right.

None of the Cypress threads can "talk" to each other, so your project may need a bit of extra configuration if this is needed. For example, let's say your first thread logs in to a website and you'd like this session to be maintained across your other threads. You could have the first Cypress thread log in and then save a file containing all of the cookies that the other threads need. You can make use of the `waitForFileExist` option to help make such functionality possible for your project. [cypress-wordpress-session](https://www.npmjs.com/package/cypress-wordpress-session) is an example of a Cypress addon that can be used to create & load a cookies file for a persistent session across multiple threads.

### Overriding options in the command line

The module makes use of `argv` to allow options to be overriden via the command line. Arguments passed in via the command line will take precedence over any options set via your node application. For example, let's say you want to override the `reportDir` option. You can run your node application with a standard kebab-case argument (eg. `--report-dir="my-report-dir"`) and the `reportDir` will be overriden.

## Options

| Name                | Type    | Default value               | Description                                                                                                                                                                                                                                                                    |
| ------------------- | ------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cypressConfig`     | object  | null                        | The config that'll be passed through to every Cypress instance. For specific options, see table below                                                                                                                                                                          |
| `reportDir`         | string  | null                        | The location to save the full report to                                                                                                                                                                                                                                        |
| `allureReportDir`   | string  | `<reportDir>/allure-report` | A different location to save the Allure report, specifically                                                                                                                                                                                                                   |
| `specsDir`          | string  | null                        | The top-level directory containing all Cypress spec files are                                                                                                                                                                                                                  |
| `openAllure`        | boolean | false                       | Open the Allure report after it's generated.<br>If `combineAllure` is also passed in, it'll open the combined Allure report instead.<br>If `hostAllure` is also passed in, `openAllure` will be ignored.                                                                       |
| `open`              | boolean | false                       | Alias for `openAllure`                                                                                                                                                                                                                                                         |
| `combineAllure`     | boolean | false                       | Combine the Allure report into a single file (complete.html)                                                                                                                                                                                                                   |
| `combine`           | boolean | false                       | Alias for `combineAllure`                                                                                                                                                                                                                                                      |
| `hostAllure`        | boolean | false                       | Spin up a localhost for the Allure report after it's generated                                                                                                                                                                                                                 |
| `host`              | boolean | false                       | Alias for `hostAllure`                                                                                                                                                                                                                                                         |
| `waitForFileExist`  | object  | null                        | Wait for a specific file to exist before subsequent threads begin. For specific options, see table below                                                                                                                                                                       |
| `maxThreadRestarts` | number  | 5                           | Should an instance of Cypress crash, it may be restarted up to this many times until all threads complete successfully. Note that any spec file that fails in a `beforeEach` hook will be considered a crash. This behaviour may be amended in a future version of this module |

### cypressConfig

| Name       | Type   | Default value | Description                                                                                                                        |
| ---------- | ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `filepath` | string | null          | A config file to be passed through to every Cypress instance                                                                       |
| `object`   | object | null          | A config object to be passed through to every Cypress instance. Any overlapping options will override those set via the `filepath` |

### waitForFileExist

| Name                    | Type    | Default value | Description                                                                                                                        |
| ----------------------- | ------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `filepath`              | string  | null          | The file you wish all threads except the first one to wait for                                                                     |
| `timeout`               | number  | 60            | The maximum amount of time to wait for. The threads will begin when the time elapses, regardless of whether the file exists or not |
| `deleteAfterCompletion` | boolean | false         | Delete the file once all threads have completed                                                                                    |
