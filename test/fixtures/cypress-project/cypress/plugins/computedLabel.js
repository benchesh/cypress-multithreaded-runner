// Reads a value from the file next to this one, as a project might read a .env file in setupNodeEvents. It's found
// with __dirname, so test discovery has to load the config file as Node does, where every file has its own __dirname
const fs = require('fs');
const path = require('path');

module.exports = () => fs.readFileSync(path.join(__dirname, 'computed-label.txt'), 'utf8').trim();
