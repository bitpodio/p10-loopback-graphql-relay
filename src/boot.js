'use strict';

const graphql = require('graphql-server-express');
const bodyParser = require('body-parser');
const { getSchema } = require('./schema/index');
const startSubscriptionServer = require('./subscriptions');
const expressPlayground = require('graphql-playground-middleware-express').default

module.exports = function (app, options) {
  try {
    const models = app.models();
    const schema = getSchema(models, options);
    const path = options.path || '/graphql';

    // app.get(path, expressPlayground({ endpoint: path }))

    app.get('/svc/playground', expressPlayground({ endpoint: path }))

    app.use(path, bodyParser.json(), graphql.graphqlExpress(req => ({
      schema,
      context: {
        app,
        req,
        organizationCache: options.organizationCache,
        findOrgIdFromDomain: options.findOrgIdFromDomain,
      }
    })));

    startSubscriptionServer(app, schema, options);
  }
  catch (err) {
    console.log('Error in starting graphql endpoint and subscription server. Error details: ', err);
  }
};
