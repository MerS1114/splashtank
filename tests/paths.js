// Where the tests find the built page and put their screenshots and downloads.
const path = require('path'), fs = require('fs');
const PAGE = path.resolve(__dirname, '../dist/SplashTank.html');
const OUT = path.resolve(__dirname, '../test-output');
fs.mkdirSync(OUT, { recursive: true });
module.exports = { PAGE, OUT };
