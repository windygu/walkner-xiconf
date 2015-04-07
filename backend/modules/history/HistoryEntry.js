// Copyright (c) 2014, Łukasz Walukiewicz <lukasz@walukiewicz.eu>. Some Rights Reserved.
// Licensed under CC BY-NC-SA 4.0 <http://creativecommons.org/licenses/by-nc-sa/4.0/>.
// Part of the walkner-xiconf project <http://lukasz.walukiewicz.eu/p/walkner-xiconf>

'use strict';

var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var Order = require('./Order');

module.exports = HistoryEntry;

function HistoryEntry(db, broker, settings)
{
  this.db = db;
  this.broker = broker;
  this.settings = settings;

  this.inputMode = 'local';
  this.workMode = 'programming';
  this.inProgress = false;
  this.overallProgress = 0;
  this.remoteConnected = false;
  this.remoteData = null;
  this.remoteLeader = null;
  this.selectedOrderNo = null;
  this.selectedNc12 = null;
  this.waitingForLeds = false;
  this.waitingForContinue = false;

  this.clear();
}

HistoryEntry.prototype.toJSON = function()
{
  return {
    _id: this._id,
    order: this.order ? this.order.toJSON() : null,
    nc12: this.nc12,
    serviceTag: this.serviceTag,
    counter: this.counter,
    startedAt: this.startedAt,
    finishedAt: this.finishedAt,
    duration: this.duration,
    log: Array.isArray(this.log) ? [].concat(this.log) : null,
    result: this.result,
    errorCode: this.errorCode,
    exception: this.exception,
    output: this.output,
    featureFile: this.featureFile,
    featureFileName: this.featureFileName,
    featureFileHash: this.featureFileHash,
    feature: this.feature,
    workflowFile: this.workflowFile,
    workflow: this.workflow,
    countdown: this.countdown,
    program: this.program,
    steps: this.steps,
    leds: this.leds,
    inputMode: this.inputMode,
    workMode: this.workMode,
    inProgress: this.inProgress,
    overallProgress: this.overallProgress,
    remoteConnected: this.remoteConnected,
    remoteData: this.remoteData,
    remoteLeader: this.remoteLeader,
    selectedOrderNo: this.selectedOrderNo,
    selectedNc12: this.selectedNc12,
    waitingForLeds: this.waitingForLeds,
    waitingForContinue: this.waitingForContinue
  };
};

HistoryEntry.prototype.isInProgress = function()
{
  return this.inProgress;
};

HistoryEntry.prototype.isFinished = function()
{
  return this.finishedAt !== null;
};

HistoryEntry.prototype.getSelectedOrderData = function()
{
  return _.find(this.remoteData, {_id: this.selectedOrderNo}) || null;
};

HistoryEntry.prototype.isLedOnly = function()
{
  var selectedOrderData = this.getSelectedOrderData();

  if (!selectedOrderData || this.program)
  {
    return false;
  }

  var programs = 0;
  var leds = 0;

  _.forEach(selectedOrderData.items, function(item)
  {
    if (item.kind === 'program')
    {
      ++programs;
    }
    else if (item.kind === 'led')
    {
      ++leds;
    }
  });

  return programs === 0 && leds > 0;
};

HistoryEntry.prototype.hasProgramStep = function(type)
{
  if (!this.program)
  {
    return false;
  }

  for (var i = 0; i < this.program.steps.length; ++i)
  {
    var step = this.program.steps[i];

    if (step.enabled && step.type === type)
    {
      return true;
    }
  }

  return false;
};

HistoryEntry.prototype.createServiceTagRequestData = function()
{
  var ledsMap = {};
  var ledsList = [];
  var leds = Array.isArray(this.leds) ? this.leds : [];

  for (var i = 0; i < leds.length; ++i)
  {
    var led = leds[i];

    if (!ledsMap[led.nc12])
    {
      ledsMap[led.nc12] = [];
      ledsList.push({
        nc12: led.nc12,
        serialNumbers: ledsMap[led.nc12]
      });
    }

    if (led.serialNumber !== null)
    {
      ledsMap[led.nc12].push(led.serialNumber);
    }
  }

  return {
    orderNo: this.order.no,
    nc12: this.nc12,
    multi: _.isString(this.workflow) && /multidevice\s*=\s*true/i.test(this.workflow),
    leds: ledsList
  };
};

HistoryEntry.prototype.clear = function(clearOrder, clearProgram)
{
  this._id = null;

  if (clearOrder !== false)
  {
    this.order = null;
    this.counter = null;
    this.nc12 = null;
  }

  if (clearProgram !== false)
  {
    this.program = null;
  }

  this.serviceTag = null;
  this.startedAt = null;
  this.finishedAt = null;
  this.duration = null;
  this.log = null;
  this.result = null;
  this.errorCode = null;
  this.exception = null;
  this.output = null;
  this.featureFile = null;
  this.featureFileName = null;
  this.featureFileHash = null;
  this.feature = null;
  this.workflowFile = null;
  this.workflow = null;
  this.countdown = -1;
  this.steps = null;
  this.metrics = null;
  this.leds = null;
  this.waitingForLeds = false;
  this.waitingForContinue = false;
  this.inProgress = false;
  this.overallProgress = 0;
};

HistoryEntry.prototype.reset = function(orderNo, quantity, nc12)
{
  this.startedAt = Date.now();
  this._id = (this.startedAt + Math.round(Math.random() * 9999999)).toString(36).toUpperCase();
  this.nc12 = nc12;
  this.serviceTag = null;
  this.log = [];
  this.finishedAt = null;
  this.duration = null;
  this.result = null;
  this.errorCode = null;
  this.exception = null;
  this.output = null;
  this.featureFile = null;
  this.featureFileName = null;
  this.featureFileHash = null;
  this.feature = null;
  this.workflowFile = null;
  this.workflow = null;
  this.countdown = -1;
  this.steps = null;
  this.metrics = null;
  this.leds = [];

  this.setUpProgram();
  this.setUpLeds();

  this.waitingForLeds = this.settings.get('ledsEnabled') > 0
    && this.settings.supportsFeature('led')
    && this.leds.length > 0;
  this.waitingForContinue = false;
  this.inProgress = true;
  this.overallProgress = 1;

  if (orderNo === null)
  {
    this.order = null;
    this.counter = 0;
  }
  else if (this.order === null || !this.order.isSameOrder(orderNo, quantity))
  {
    this.order = new Order(this.startedAt, orderNo, quantity);
    this.counter = 0;

    this.log.push({
      time: this.startedAt,
      text: 'ORDER_CREATED',
      orderNo: this.order.no,
      quantity: this.order.quantity
    });
  }
  else
  {
    this.log.push({
      time: this.startedAt,
      text: 'ORDER_CONTINUED',
      orderNo: this.order.no,
      quantity: this.order.quantity,
      counter: this.counter + 1
    });
  }

  if (_.isEmpty(this.nc12) && this.waitingForLeds && !this.program)
  {
    this.log.push({
      time: this.startedAt,
      text: 'LED_CHECKING_STARTED'
    });
  }
  else
  {
    this.log.push({
      time: this.startedAt,
      text: 'PROGRAMMING_STARTED',
      nc12: this.nc12 || '-'
    });
  }
};

HistoryEntry.prototype.setUpLeds = function()
{
  if (this.inputMode !== 'remote')
  {
    return;
  }

  var orderData = this.getSelectedOrderData();

  if (!orderData)
  {
    return;
  }

  for (var i = 0; i < orderData.items.length; ++i)
  {
    var item = orderData.items[i];

    if (item.kind !== 'led')
    {
      continue;
    }

    var ledsPerResult = Math.floor(item.quantityTodo / orderData.quantityTodo);

    for (var ii = 0; ii < ledsPerResult; ++ii)
    {
      this.leds.push({
        nc12: item.nc12,
        name: item.name,
        serialNumber: null,
        status: 'waiting' // waiting, checking, checked or an error object
      });
    }
  }
};

HistoryEntry.prototype.setUpProgram = function()
{
  if (!this.program)
  {
    return;
  }

  this.steps = this.program.steps.map(function()
  {
    return {
      status: 'idle',
      progress: 0,
      value: 0
    };
  });

  this.metrics = {
    uSet: [],
    uGet: [],
    i: []
  };
};

HistoryEntry.prototype.hashFeatureFile = function()
{
  this.featureFileHash = typeof this.feature === 'string'
    ? crypto.createHash('md5').update(this.feature, 'utf8').digest('hex')
    : null;

  return this.featureFileHash;
};

HistoryEntry.prototype.save = function(featureDbPath, done)
{
  var historyEntry = this;

  if (this.order)
  {
    this.order.save(this.db, this.broker, saveHistoryEntry);
  }
  else
  {
    saveHistoryEntry();
  }

  function saveHistoryEntry(err)
  {
    if (err)
    {
      return done(err);
    }

    if (historyEntry.featureFileHash === null)
    {
      return saveInDb(done);
    }

    return saveOnDisk(done);
  }

  function saveOnDisk(done)
  {
    var file = path.join(featureDbPath, historyEntry.featureFileHash);

    fs.writeFile(file, historyEntry.feature, {flag: 'wx'}, function(err)
    {
      if (err && err.code !== 'EEXIST')
      {
        return done(err);
      }

      return saveInDb(done);
    });
  }

  function saveInDb(done)
  {
    var sql = "\
      REPLACE INTO historyEntries (\
        _id, _order, nc12, counter, startedAt, finishedAt, duration,\
        log, result, errorCode, exception, output, featureFile,\
        featureFileName, featureFileHash, workflowFile, workflow,\
        program, steps, metrics, serviceTag, leds, prodLine\
      ) VALUES (\
        $_id, $_order, $nc12, $counter, $startedAt, $finishedAt, $duration,\
        $log, $result, $errorCode, $exception, $output, $featureFile,\
        $featureFileName, $featureFileHash, $workflowFile, $workflow,\
        $program, $steps, $metrics, $serviceTag, $leds, $prodLine\
      )";
    var params = {
      $_id: historyEntry._id,
      $_order: historyEntry.order ? historyEntry.order._id : null,
      $nc12: historyEntry.nc12,
      $counter: historyEntry.counter,
      $startedAt: historyEntry.startedAt,
      $finishedAt: historyEntry.finishedAt,
      $duration: historyEntry.duration,
      $log: JSON.stringify(historyEntry.log),
      $result: historyEntry.result,
      $errorCode: historyEntry.errorCode,
      $exception: historyEntry.exception,
      $output: historyEntry.output,
      $featureFile: historyEntry.featureFile,
      $featureFileName: historyEntry.featureFileName,
      $featureFileHash: historyEntry.featureFileHash,
      $workflowFile: historyEntry.workflowFile,
      $workflow: historyEntry.workflow,
      $program: historyEntry.program ? JSON.stringify(historyEntry.program) : null,
      $steps: historyEntry.steps ? JSON.stringify(historyEntry.steps) : null,
      $metrics: historyEntry.metrics ? JSON.stringify(historyEntry.metrics) : null,
      $serviceTag: historyEntry.serviceTag,
      $leds: Array.isArray(historyEntry.leds) && historyEntry.leds.length ? JSON.stringify(historyEntry.leds) : null,
      $prodLine: historyEntry.settings.get('prodLine') || null
    };

    historyEntry.db.run(sql, params, done);
  }
};
