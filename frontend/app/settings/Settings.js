// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

define([
  'underscore',
  '../core/Model'
], function(
  _,
  Model
) {
  'use strict';

  var AVAILABLE_FEATURES = window.AVAILABLE_FEATURES || [];

  return Model.extend({

    urlRoot: '/settings',

    clientUrlRoot: '#settings',

    topicPrefix: 'settings',

    nlsDomain: 'settings',

    initHotkeys: function()
    {
      var actionToHotkey = this.get('hotkeys');
      var hotkeyToActions = this.hotkeyToActions = {};

      if (!actionToHotkey)
      {
        return;
      }

      Object.keys(actionToHotkey).forEach(function(action)
      {
        var hotkey = actionToHotkey[action];

        if (hotkey === 'Space')
        {
          hotkey = ' ';
        }

        if (hotkeyToActions[hotkey] === undefined)
        {
          hotkeyToActions[hotkey] = [action];
        }
        else
        {
          hotkeyToActions[hotkey].push(action);
        }
      });
    },

    getLicenseFeatures: function()
    {
      var licenseInfo = this.get('licenseInfo');

      if (!licenseInfo || !licenseInfo.features)
      {
        return '';
      }

      return AVAILABLE_FEATURES
        .filter(function(feature) { return this.supportsFeature(feature); }, this)
        .join(', ')
        .toUpperCase();
    },

    isValidLicense: function()
    {
      var licenseInfo = this.get('licenseInfo');

      return licenseInfo && !licenseInfo.error;
    },

    supportsFeature: function(feature)
    {
      var licenseInfo = this.get('licenseInfo');

      if (!licenseInfo)
      {
        return false;
      }

      var supportedFeatures = licenseInfo.features;
      var featureIndex = AVAILABLE_FEATURES.indexOf(feature.toLowerCase());

      return featureIndex !== -1 && !!(supportedFeatures & Math.pow(2, featureIndex));
    },

    isFtOrder: function(orderName)
    {
      var patterns = this.get('ftOrderPattern');

      if (patterns.length === 0)
      {
        return true;
      }

      if (typeof orderName !== 'string')
      {
        orderName = '';
      }

      patterns = patterns.split('\n');

      for (var i = 0; i < patterns.length; ++i)
      {
        var pattern = patterns[i];

        try
        {
          var re = new RegExp(pattern, 'i');

          if (re.test(orderName))
          {
            return true;
          }
        }
        catch (err)
        {
          if (orderName.indexOf(pattern) !== -1)
          {
            return true;
          }
        }
      }

      return false;
    }

  });
});
