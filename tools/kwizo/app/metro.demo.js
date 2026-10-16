// Metro config of the demo build: the project's own config, plus one alias.
const path = require('path');
const config = require('./metro.config.original.js');
const wrapper = path.join(__dirname, 'kwizo-demo/socketio-polling.js');
const prev = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'socket.io-client' && context.originModulePath !== wrapper) return { type: 'sourceFile', filePath: wrapper };
  return prev ? prev(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};
module.exports = config;
