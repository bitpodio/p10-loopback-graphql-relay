"use strict";

const _ = require("lodash");

const { mutationWithClientMutationId } = require("graphql-relay");

const promisify = require("promisify-node");
const { connectionFromPromisedArray } = require("graphql-relay");
const { overrideRemoteOptions } = require("../overrideRemoteOptions");
const utils = require("../utils");
const checkAccess = require("../ACLs");
// const { getType } = require('../../types/type');

const allowedVerbs = ["post", "del", "put", "patch", "all"];

function checkAccessAndCallMethod({
  req: req,
  model: model,
  method: method,
  id: modelId,
  typeObj: typeObj,
  params: params,
}) {
  return checkAccess({
    req: req,
    model: model,
    method: method,
    id: modelId
  })
    .then(() => {
      const wrap = promisify(model[method.name]);
      if (typeObj.list) {
        return connectionFromPromisedArray(
          wrap.apply(model, params),
          args,
          model
        );
      }
      return wrap.apply(model, params);
    });
}

module.exports = function getRemoteMethodMutations(model) {
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
        const acceptingParams = utils.getRemoteMethodInput(
          method,
          typeObj.list
        );
        const hookName = utils.getRemoteMethodQueryName(model, method);

        hooks[hookName] = mutationWithClientMutationId({
          name: hookName,
          description: method.description,
          meta: { relation: true },
          inputFields: acceptingParams,
          outputFields: {
            obj: {
              type: typeObj.type,
              resolve: o => o
            }
          },
          mutateAndGetPayload: (args, context) => {
            const params = [];

            if (args.options) {
              args.options = Object.assign({}, args.options);
            }
            const contextOptions = overrideRemoteOptions(context);
            args.options = Object.assign(contextOptions, args.options || {}); // these options will directly passed into the dao layer

            _.forEach(acceptingParams, (param, name) => {
              params.push(args[name]);
            });
            var modelId = args && args.id;
            const req = context.req;
            const domain = req.headers["x-forwarded-host"];
            const xOrgId = req.headers["x-org-id"];
            const findOrgIdFromDomain = context.findOrgIdFromDomain;
            const organizationCache = context.organizationCache;
            if (model.modelName === "Organization") {
              if (args.id && args.id === "this") {
                if (xOrgId) {
                  return organizationCache.find(xOrgId)
                    .then(orgId => setOrgIdIn('args', orgId))
                    .then(() => checkAccessAndCallMethod({
                      req: context.req,
                      model: model,
                      method: method,
                      id: modelId,
                      typeObj: typeObj,
                      params: params,
                    }));
                } else if (domain) {
                  return findOrgIdFromDomain(domain)
                    .then(organizationCache.find)
                    .then(orgId => setOrgIdIn('args', orgId))
                    .then(() => checkAccessAndCallMethod({
                      req: context.req,
                      model: model,
                      method: method,
                      id: modelId,
                      typeObj: typeObj,
                      params: params,
                    }));
                } else {
                  throw new Error("No x-org-id or domain (x-forwarded-host) found for resolution of Organiation id.")
                }
              }
            }
            if (xOrgId) {
              return organizationCache.find(xOrgId)
                .then(orgId => setOrgIdIn('req', orgId))
                .then(() => checkAccessAndCallMethod({
                  req: context.req,
                  model: model,
                  method: method,
                  id: modelId,
                  typeObj: typeObj,
                  params: params,
                }));
            } else if (domain) {
              return findOrgIdFromDomain(domain)
                .then(organizationCache.find)
                .then(orgId => setOrgIdIn('req', orgId))
                .then(() => checkAccessAndCallMethod({
                  req: context.req,
                  model: model,
                  method: method,
                  id: modelId,
                  typeObj: typeObj,
                  params: params,
                }));
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
            }
          }
      })
      }
    });
  }
  return hooks;
};
