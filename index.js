const { execSync } = require('child_process');

const runShellCommand = (cmd) => {
  execSync(cmd, {
    stdio: [null, process.stdout, process.stderr],
  });
};

module.exports = (config = {}) => {
  runShellCommand(`node -e 'const scr=require("${__dirname}/async");scr(${JSON.stringify(
    require('./lib/process-args').getFullConfig(config)
  )});'`);
};

