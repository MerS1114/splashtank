// Where the tests find the built page and put their screenshots and downloads.
const path = require('path'), fs = require('fs');
// SPLASH_PAGE: test another copy of the page, a file or a web address (e.g. https://mers1114.github.io/splashtank/testing/)
const PAGE = process.env.SPLASH_PAGE || path.resolve(__dirname, '../dist/SplashTank.html');
const OUT = path.resolve(__dirname, '../test-output');
fs.mkdirSync(OUT, { recursive: true });
module.exports = { PAGE, OUT };
