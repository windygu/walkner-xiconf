// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

const fs = require('fs');
const glob = require('glob');
const step = require('h5.step');

module.exports = function setSettingsRoutes(app, settingsModule)
{
  const express = app[settingsModule.config.expressId];
  const logsDls = {};

  express.get('/settings', function(req, res)
  {
    res.send(settingsModule.export());
  });

  express.get('/settings/:name', function(req, res)
  {
    if (!settingsModule.has(req.params.name))
    {
      return res.sendStatus(404);
    }

    return res.send(settingsModule.get(req.params.name));
  });

  express.post('/settings', function(req, res, next)
  {
    if (typeof req.body !== 'object' || req.body === null)
    {
      return res.sendStatus(400);
    }

    const programmer = app[settingsModule.config.programmerId];

    if (programmer && programmer.currentState.isInProgress())
    {
      res.statusCode = 400;

      return next(new Error('LOCKED'));
    }

    settingsModule.import(req.body, function(err)
    {
      if (err)
      {
        return next(err);
      }

      return res.sendStatus(204);
    });
  });

  express.get('/settings;export', function(req, res)
  {
    const settings = settingsModule.export(req.query.password);

    res.type('application/json');
    res.attachment('XICONF_SETTINGS_' + settings.id + '.txt');
    res.send(JSON.stringify(settings, null, 2));
  });

  express.post('/settings;restart', function(req, res, next)
  {
    if (settingsModule.get('password') !== req.body.password)
    {
      res.statusCode = 400;

      return next(new Error('AUTH'));
    }

    const programmer = app[settingsModule.config.programmerId];

    if (programmer && programmer.currentState.isInProgress())
    {
      res.statusCode = 400;

      return next(new Error('LOCKED'));
    }

    res.json({});

    setTimeout(() => process.exit(666), 300);
  });

  express.post('/settings;logs', function(req, res, next)
  {
    if (settingsModule.get('password') !== req.body.password)
    {
      res.statusCode = 400;

      return next(new Error('AUTH'));
    }

    glob(settingsModule.config.logsGlob, function(err, files)
    {
      if (err)
      {
        return next(err);
      }

      if (!files.length)
      {
        res.statusCode = 400;

        return next(new Error('EMPTY'));
      }

      findLatestLogsFile(files, function(err, file)
      {
        if (err)
        {
          return next(err);
        }

        var id = (Date.now().toString(16) + Math.round(Math.random() * 999999999999).toString(16)).toUpperCase();

        logsDls[id] = file;

        setTimeout(() => delete logsDls[id], 10000);

        res.json(id);
      });
    });
  });

  express.get('/settings;logs', function(req, res, next)
  {
    if (!logsDls[req.query.id])
    {
      res.statusCode = 400;

      return next(new Error('AUTH'));
    }

    res.download(logsDls[req.query.id]);
  });

  function findLatestLogsFile(files, done)
  {
    if (files.length === 1)
    {
      return setImmediate(done, null, files[0]);
    }

    step(
      function()
      {
        files.forEach(f => fs.stat(f, this.group()), this);
      },
      function(err, stats)
      {
        if (err)
        {
          return done(err);
        }

        const latestLogsFile = stats
          .map((stat, i) => ({stat, file: files[i]}))
          .sort((a, b) => a.stat.mtime - b.stat.mtime)
          .pop()
          .file;

        done(null, latestLogsFile);
      }
    );
  }
};
