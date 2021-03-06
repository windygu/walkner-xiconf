// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var fs = require('fs');
var path = require('path');

module.exports = function findFeatureFile(featureFilePath, nc12, timeout, done)
{
  timeout = parseInt(timeout, 10);

  if (isNaN(timeout) || timeout < 100)
  {
    timeout = 30000;
  }

  var timer = setTimeout(cancel, timeout);
  var cancelled = false;

  function cancel()
  {
    if (cancelled)
    {
      return;
    }

    clearTimeout(timer);
    timer = null;
    cancelled = true;

    return done(null, false);
  }

  fs.readdir(featureFilePath, function(err, files)
  {
    if (cancelled)
    {
      return;
    }

    clearTimeout(timer);

    if (err)
    {
      return done(err, null);
    }

    var pattern = new RegExp(nc12 + '.*?\\.(xml|txt)$', 'i');

    files = files.filter(function(file) { return pattern.test(file); });

    if (files.length)
    {
      return done(null, path.join(featureFilePath, files[0]), files);
    }

    return done(null, null);
  });

  return cancel;
};
