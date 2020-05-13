"use strict";

const _ = require("lodash");

const promisify = require("promisify-node");
const checkAccess = require("../ACLs");

const utils = require("../utils");
const { connectionFromPromisedArray } = require("graphql-relay");
const { overrideRemoteOptions } = require("../overrideRemoteOptions");
const allowedVerbs = ["get", "head"];

const checkAccessMiddlewareFactory = (acceptingParams, model, method, isList) => (...inputArgs) => {
  const args = inputArgs[1];
  const context = inputArgs[2];
  const modelId = args && args.id;
  const params = [];
  _.forEach(acceptingParams, (param, name) => {
    params.push(name === "filter" ? ( args[name] || {}) : args[name]);
  });
  return checkAccess({
    req: context.req,
    model: model,
    method: method,
    id: modelId
  })
    .then(() => {
      const wrap = promisify(model[method.name]);
      const filteredParams = _.compact(params);
      if (isList) {
        return connectionFromPromisedArray(
          wrap.apply(model, filteredParams),
          args,
          model
        );
      }
      return wrap.apply(model, filteredParams);
    })
    .catch(err => {
      throw err;
    });
}
const replaceThisWithOrgId = (orgId, { url }) => {
  return url.replace(/\/Organizations\/this/ig, `/Organizations/${orgId}`);
}

const organizationResolveMiddleware = (...inputArgs) => {
  const __ = inputArgs[0];
  const args = inputArgs[1];
  const context = inputArgs[2];
  const info = inputArgs[3];
  const req = context.req;
  const domain = req.headers["x-forwarded-host"];
  const xOrgId = req.headers["x-org-id"];
  const findOrgIdFromDomain = context.findOrgIdFromDomain;
  const organizationCache = context.organizationCache;
  if (info.parentType.description === "Organization" && args.id && args.id === "this") {
    if (xOrgId) {
      return organizationCache.find(xOrgId).then(orgId => setOrgIdIn('args', orgId));
    } else if (domain) {
      return findOrgIdFromDomain(domain).then(organizationCache.find).then(orgId => setOrgIdIn('args', orgId));
    } else {
      throw new Error("No x-org-id or domain (x-forwarded-host) found for resolution of Organiation id.")
    }
  }
  if (xOrgId) {
    return organizationCache.find(xOrgId).then(orgId => setOrgIdIn('req', orgId));
  } else if (domain) {
    return findOrgIdFromDomain(domain).then(organizationCache.find).then(orgId => setOrgIdIn('req', orgId));
  }

  function setOrgIdIn(argsOrReq, orgId) {
    if (orgId) {
      if (argsOrReq === "args") {
        args.id = orgId;
      } else if (argsOrReq === "req") {
        args.options.orgId = parseInt(orgId);
      }
      req.orgId = parseInt(orgId);
    } else {
      const errorMsg = xOrgId ? "x-org-id " + xOrgId : "domain (x-forwarded-host) " + domain;
      throw new Error("Unable to resolve Organization id with value of " + errorMsg);
    }
    return [__, args, context, info];
  }
  return [__, args, context, info];
}

const resolverMiddleware = (__, args, context, info) => {
  const contextOptions = overrideRemoteOptions(context);
  args.options = Object.assign(contextOptions, args.options || {});
  if (args.options) {
    args.options = Object.assign({}, args.options);
  }
  return Promise.resolve([__, args, context, info]);
}

function pipe(...fns) {
  return (...args) => {
    return fns.reduce((prev, currentMiddleware) => {
      return prev.then(res => currentMiddleware(...res))
    }, Promise.resolve(args));
  }
}

module.exports = function getRemoteMethodQueries(model) {
  const hooks = {};

  if (model.sharedClass && model.sharedClass.methods) {
    model.sharedClass.methods().forEach(method => {
      if (
        method.name.indexOf("Stream") === -1 &&
        method.name.indexOf("invoke") === -1
      ) {
        if (!utils.isRemoteMethodAllowed(method, allowedVerbs)) {
          return;
        }
        // TODO: Add support for static methods
        if (method.isStatic === false) {
          return;
        }
        const typeObj = utils.getRemoteMethodOutput(method);
        const acceptingParams = utils.getRemoteMethodInput(method, typeObj.list);
        const hookName = utils.getRemoteMethodQueryName(model, method);
        hooks[hookName] = {
          name: hookName,
          description: method.description,
          meta: { relation: true },
          args: acceptingParams,
          type: typeObj.type,
          resolve: pipe(resolverMiddleware, organizationResolveMiddleware, checkAccessMiddlewareFactory(acceptingParams, model, method, typeObj.list)),
        };
      }
    });
  }

  return hooks;
};
