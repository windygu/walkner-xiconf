// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

const path = require('path');
const _ = require('lodash');
const express = require('express');
const ExpressView = require('express/lib/view');
const methods = require('methods');
const ejs = require('ejs');
const ejsAmd = require('ejs-amd');
const messageFormatAmd = require('messageformat-amd');
const wrapAmd = require('./wrapAmd');
const rqlMiddleware = require('./rqlMiddleware');
const errorHandlerMiddleware = require('./errorHandlerMiddleware');
const crud = require('./crud');
const monkeyPatch = require('./monkeyPatch');
let cookieParser = null;
let bodyParser = null;
let session = null;
let pmx = null;
let MongoStore = null;

try { cookieParser = require('cookie-parser'); }
catch (err) { console.log('Failed to load cookie-parser: %s', err.message); }

try { bodyParser = require('body-parser'); }
catch (err) { console.log('Failed to load body-parser: %s', err.message); }

try { require('iconv-lite').encodingExists('UTF-8'); }
catch (err) { console.log('Failed to load iconv-lite: %s', err.message); }

try { session = require('express-session'); }
catch (err) { console.log('Failed to load express-session: %s', err.message); }

try { pmx = require('pmx'); }
catch (err) { console.log('Failed to load pmx: %s', err.message); }

try { MongoStore = require('./MongoStore'); }
catch (err) { console.log('Failed to load MongoStore %s', err.message); }

exports.DEFAULT_CONFIG = {
  mongooseId: 'mongoose',
  staticPath: 'public',
  staticBuildPath: 'public-build',
  sessionCookieKey: 'express.sid',
  sessionCookie: {
    maxAge: null,
    path: '/',
    httpOnly: true
  },
  sessionStore: {},
  cookieSecret: null,
  ejsAmdHelpers: {},
  title: 'express',
  jsonBody: {},
  textBody: {},
  urlencodedBody: {},
  ignoredErrorCodes: ['ECONNRESET', 'ECONNABORTED'],
  routes: (app, expressModule) => { /* jshint unused:false */ }
};

exports.start = function startExpressModule(app, expressModule)
{
  const config = expressModule.config;
  const mongoose = app[config.mongooseId];
  const development = app.options.env === 'development';
  const staticPath = config[development ? 'staticPath' : 'staticBuildPath'];
  const expressApp = express();

  expressModule.staticPath = staticPath;

  expressModule.app = expressApp;

  expressModule.crud = crud;

  expressModule.sessionStore = mongoose
    ? new MongoStore(mongoose.connection.db, config.sessionStore)
    : session ? new session.MemoryStore() : null;

  expressModule.router = express.Router();

  expressModule.createHttpError = function(message, statusCode)
  {
    var httpError = new Error(message);
    httpError.status = statusCode || 400;

    return httpError;
  };

  _.forEach(methods, function(method)
  {
    expressModule[method] = function()
    {
      return expressModule.router[method].apply(expressModule.router, arguments);
    };
  });

  expressApp.engine('ejs', ejs.renderFile);
  expressApp.set('trust proxy', true);
  expressApp.set('view engine', 'ejs');
  expressApp.set('views', app.pathTo('templates'));

  if (development)
  {
    expressApp.set('json spaces', 2);
  }

  app.broker.publish('express.beforeMiddleware', {
    module: expressModule
  });

  if (development)
  {
    setUpDevMiddleware(staticPath);
  }

  if (config.cookieSecret && cookieParser)
  {
    expressApp.use(cookieParser(config.cookieSecret));
  }

  if (bodyParser)
  {
    expressApp.use(bodyParser.json(config.jsonBody));
    expressApp.use(bodyParser.urlencoded(_.assign({extended: false}, config.urlencodedBody)));
    expressApp.use(bodyParser.text(_.defaults({type: 'text/*'}, config.textBody)));
  }

  expressApp.use(rqlMiddleware());

  if (expressModule.sessionStore)
  {
    const sessionMiddleware = session({
      store: expressModule.sessionStore,
      key: config.sessionCookieKey,
      cookie: config.sessionCookie,
      secret: config.cookieSecret,
      saveUninitialized: true,
      resave: false,
      rolling: true
    });

    expressApp.use(function checkSessionMiddleware(req, res, next)
    {
      if (/^\/(app|assets|vendor)\//.test(req.url))
      {
        next();
      }
      else
      {
        sessionMiddleware(req, res, next);
      }
    });
  }

  expressApp.use('/', expressModule.router);

  app.broker.publish('express.beforeRouter', {
    module: expressModule
  });

  if (typeof expressModule.config.routes === 'function')
  {
    expressModule.config.routes(app, expressModule);
  }

  expressApp.use(express.static(staticPath));

  if (pmx !== null)
  {
    expressApp.use(pmx.expressErrorHandler());
  }

  var errorHandlerOptions = {
    title: config.title,
    basePath: path.resolve(__dirname, '../../../')
  };

  expressApp.use(errorHandlerMiddleware(expressModule, errorHandlerOptions));

  monkeyPatch(app, expressModule, {
    View: ExpressView
  });

  /**
   * @private
   * @param {string} staticPath
   */
  function setUpDevMiddleware(staticPath)
  {
    ejsAmd.wrapAmd = wrapEjsAmd.bind(null, config.ejsAmdHelpers);

    const templateUrlRe = /^\/app\/([a-zA-Z0-9\-]+)\/templates\/(.*?)\.js$/;
    const ejsAmdMiddleware = ejsAmd.middleware({
      views: staticPath
    });

    expressApp.use(function runEjsAmdMiddleware(req, res, next)
    {
      const matches = req.url.match(templateUrlRe);

      if (matches === null)
      {
        return next();
      }

      ejsAmdMiddleware(req, res, next);
    });

    expressApp.use('/app/nls/locale/', messageFormatAmd.localeMiddleware());

    expressApp.use('/app/nls/', messageFormatAmd.nlsMiddleware({
      localeModulePrefix: 'app/nls/locale/',
      jsonPath: function(locale, nlsName)
      {
        const jsonFile = (locale === null ? 'root' : locale) + '.json';

        return path.join(staticPath, 'app', nlsName, 'nls', jsonFile);
      }
    }));
  }

  /**
   * @private
   * @param {object} ejsAmdHelpers
   * @param {string} js
   * @returns {string}
   */
  function wrapEjsAmd(ejsAmdHelpers, js)
  {
    return wrapAmd('return ' + js, ejsAmdHelpers);
  }
};
