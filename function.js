const { createNodeMiddleware } = require('@octokit/webhooks');
const { createProbotApp } = require('./index');

// Create the Probot instance with all event handlers
const probotApp = createProbotApp();

// Reuse the middleware to handle HTTP requests in Google Cloud Functions
const middleware = createNodeMiddleware(probotApp.webhooks, { path: '/' });

exports.probotApp = (req, res) => middleware(req, res);
