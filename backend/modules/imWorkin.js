// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var path = require('path');
var spawn = require('child_process').spawn;

exports.DEFAULT_CONFIG = {
  settingsId: 'settings',
  imWorkingExe: null
};

exports.start = function startImWorkinModule(app, module)
{
  var settings = app[module.config.settingsId];

  if (!settings)
  {
    throw new Error("settings module is required!");
  }

  var imWorkinProcess = null;

  app.broker.subscribe('settings.changed')
    .setFilter(function(changes) { return changes.imWorkin !== undefined; })
    .on('message', toggleProcess);

  app.broker.subscribe('app.started', toggleProcess).setLimit(1);

  function toggleProcess()
  {
    if (settings.get('imWorkin'))
    {
      startProcess();
    }
    else
    {
      stopProcess();
    }
  }

  function startProcess()
  {
    if (imWorkinProcess !== null)
    {
      return;
    }

    imWorkinProcess = spawn(
      module.config.imWorkingExe || path.join(app.options.rootPath, '..', 'bin', 'ImWorkin.exe')
    );

    var respawn = true;

    imWorkinProcess.stdout.setEncoding('utf8');
    imWorkinProcess.stdout.on('data', function(data)
    {
      module.debug("[stdout]", data);
    });

    imWorkinProcess.stderr.setEncoding('utf8');
    imWorkinProcess.stderr.on('data', function(data)
    {
      module.debug("[stderr]", data);
    });

    imWorkinProcess.on('error', function(err)
    {
      if (err.code === 'ENOENT')
      {
        respawn = false;
      }

      module.error(err.message);
    });

    imWorkinProcess.on('close', function(code)
    {
      module.debug("Stopped with code %d!", code);

      imWorkinProcess = null;

      if (respawn)
      {
        setTimeout(toggleProcess, 1337);
      }
    });

    module.debug("Started!");
  }

  function stopProcess()
  {
    if (imWorkinProcess === null)
    {
      return;
    }

    imWorkinProcess.kill();
  }
};
