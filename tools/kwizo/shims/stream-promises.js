const { pipeline, finished } = require('stream-browserify');
const util = require('util');
module.exports = { pipeline: util.promisify(pipeline), finished: util.promisify(finished) };
