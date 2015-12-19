// Copyright (c) 2014, Łukasz Walukiewicz <lukasz@walukiewicz.eu>. Some Rights Reserved.
// Licensed under CC BY-NC-SA 4.0 <http://creativecommons.org/licenses/by-nc-sa/4.0/>.
// Part of the walkner-xiconf project <http://lukasz.walukiewicz.eu/p/walkner-xiconf>

define([
  'app/i18n',
  'app/user',
  'app/viewport',
  'app/core/View',
  'app/core/views/DialogView',
  'app/core/util/bindLoadingMessage',
  '../HistoryEntry',
  '../views/HistoryEntryDetailsView',
  'app/history/templates/downloadAction',
  'app/history/templates/toggleResultDialog'
], function(
  t,
  user,
  viewport,
  View,
  DialogView,
  bindLoadingMessage,
  HistoryEntry,
  HistoryEntryDetailsView,
  downloadActionTemplate,
  toggleResultDialogTemplate
) {
  'use strict';

  return View.extend({

    layoutName: 'page',

    pageId: 'historyEntryDetails',

    breadcrumbs: function()
    {
      return [
        {
          label: t.bound('history', 'BREADCRUMBS:browse'),
          href: this.model.genClientUrl('base')
        },
        t.bound('history', 'BREADCRUMBS:details')
      ];
    },

    actions: function()
    {
      var model = this.model;
      var workflow = model.get('workflow');
      var feature = model.get('feature');
      var gprsOrderFile = model.get('gprsOrderFile');
      var gprsInputFile = model.get('gprsInputFile');
      var gprsOutputFile = model.get('gprsOutputFile');
      var url = model.url() + ';';
      var cancelled = !!model.get('cancelled');
      var actions = [{
        template: function()
        {
          return downloadActionTemplate({
            files: {
              gprsOrderFile: gprsOrderFile && gprsOrderFile.length ? (url + 'gprsOrder') : null,
              workflow: workflow && workflow.length ? (url + 'workflow') : null,
              feature: feature && feature.length ? (url + 'feature') : null,
              gprsInputFile: gprsInputFile && gprsInputFile.length ? (url + 'gprsInput') : null,
              gprsOutputFile: gprsOutputFile && gprsOutputFile.length ? (url + 'gprsOutput') : null
            }
          });
        }
      }];

      if (user.isLocal() && model.get('result') === 'success' && model.get('serviceTag'))
      {
        actions.unshift({
          label: t('history', 'PAGE_ACTION:' + (cancelled ? 'restore' : 'cancel')),
          icon: cancelled ? 'check' : 'ban',
          callback: this.toggleResult.bind(this)
        });
      }

      return actions;
    },

    remoteTopics: {
      'history.orderUpdated': function(changes)
      {
        var order = this.model.get('order');

        if (order && changes._id === order._id)
        {
          this.model.set('order', changes);
        }
      },
      'programmer.resultToggled': function(message)
      {
        if (this.model.id === message.resultId)
        {
          this.model.set('cancelled', message.cancelled);
        }
      }
    },

    initialize: function()
    {
      this.model = bindLoadingMessage(new HistoryEntry({_id: this.options.modelId}), this);

      this.view = new HistoryEntryDetailsView({
        model: this.model,
        tab: this.options.tab
      });
    },

    setUpLayout: function(layout)
    {
      this.listenTo(this.model, 'change:cancelled', function()
      {
        layout.setActions(this.actions, this);
      });
    },

    load: function(when)
    {
      return when(this.model.fetch());
    },

    toggleResult: function()
    {
      var cancelled = !!this.model.get('cancelled');
      var action = cancelled ? 'restore' : 'cancel';
      var dialogView = new DialogView({
        template: toggleResultDialogTemplate,
        model: {
          message: t('history', 'toggleResultDialog:message:' + action),
          action: t('history', 'toggleResultDialog:action:' + action),
          buttonClassName: cancelled ? 'success' : 'danger'
        }
      });
      var view = this;

      this.listenTo(dialogView, 'answered', function(answer)
      {
        if (answer !== 'yes')
        {
          return;
        }

        view.socket.emit('programmer.toggleResult', view.model.id, cancelled, function(err)
        {
          if (err)
          {
            viewport.msg.show({
              type: 'error',
              time: 5000,
              text: err.message
            });
          }
          else
          {
            viewport.closeDialog();
          }
        });
      });

      viewport.showDialog(dialogView, t('history', 'toggleResultDialog:title:' + action));
    }

  });
});
