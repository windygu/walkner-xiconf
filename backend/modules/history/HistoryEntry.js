// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var createHash = require('crypto').createHash;
var fs = require('fs');
var path = require('path');
var _ = require('lodash');
var step = require('h5.step');
var Order = require('./Order');

module.exports = HistoryEntry;

var TELEMANAGEMENT_MODES = {
  F: 'FutureProof',
  T: 'Telemanaged'
};
var SWITCH_REGIMES = {
  A: 'AlwaysOn',
  P: 'PhotoCell'
};
var PHOTO_CELL_LEVELS = {
  _: 'Levels_Unknown',
  A: 'Levels_38_18',
  B: 'Levels_55_28',
  C: 'Levels_70_35',
  D: 'Levels_35_18'
};

function HistoryEntry(db, broker, settings)
{
  this.db = db;
  this.broker = broker;
  this.settings = settings;

  this.inputMode = 'local';
  this.workMode = null;
  this.inProgress = false;
  this.overallProgress = 0;
  this.remoteConnected = false;
  this.remoteData = null;
  this.remoteLeader = null;
  this.selectedOrderNo = null;
  this.selectedNc12 = null;
  this.waitingForLeds = false;
  this.waitingForHidLamps = false;
  this.waitingForContinue = null;
  this.updating = null;
  this.weight = {
    time: 0,
    value: 0,
    stabilized: false,
    scan: null,
    nc12: null,
    orderNo: null,
    component: null
  };

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
    featureFileName: this.featureFileName,
    countdown: this.countdown,
    program: this.program,
    steps: this.steps,
    leds: this.leds,
    hidLamps: this.hidLamps,
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
    waitingForHidLamps: this.waitingForHidLamps,
    waitingForWeight: this.waitingForWeight,
    waitingForContinue: this.waitingForContinue,
    updating: this.updating,
    weight: this.weight
  };
};

HistoryEntry.prototype.fromDb = function(result, order)
{
  _.assign(this, _.pick(result, [
    '_id',
    'nc12',
    'counter',
    'startedAt',
    'finishedAt',
    'duration',
    'result',
    'errorCode',
    'exception',
    'output',
    'featureFile',
    'featureFileName',
    'featureFileHash',
    'workflowFile',
    'workflow',
    'serviceTag'
  ]));

  [
    'log',
    'program',
    'steps',
    'metrics',
    'leds',
    'hidLamps'
  ].forEach(function(property)
  {
    this[property] = _.isString(result[property]) ? JSON.parse(result[property]) : result[property];
  }, this);

  if (order)
  {
    this.order = _.assign(new Order(0, order.no, order.quantity), order);
  }

  return this;
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

  var other = 0;
  var leds = 0;

  _.forEach(selectedOrderData.items, function(item)
  {
    if (item.kind === 'led')
    {
      ++leds;
    }
    else
    {
      ++other;
    }
  });

  return other === 0 && leds > 0;
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
  return {
    serviceTag: this.serviceTag,
    orderNo: this.order.no,
    nc12: this.nc12,
    multi: _.isString(this.workflow) && /multidevice\s*=\s*true/i.test(this.workflow),
    leds: this.createLedsForRequestData(),
    hidLamps: this.createHidLampsForRequestData(),
    programId: this.program ? this.program._id : null,
    programName: this.program ? this.program.name : null,
    weight: !this.weight.component ? null : {
      name: this.weight.component.description,
      nc12: this.weight.nc12,
      serialNumber: this.weight.scan
    }
  };
};

HistoryEntry.prototype.createLedsForRequestData = function()
{
  var ledsList = [];
  var ledsMap = {};
  var leds = Array.isArray(this.leds) ? this.leds : [];

  if (this.settings.get('ledsEnabled') > 0 && this.settings.supportsFeature('led'))
  {
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
  }

  return ledsList;
};

HistoryEntry.prototype.createHidLampsForRequestData = function()
{
  var hidLampList = [];
  var hidLampMap = {};
  var hidLamps = Array.isArray(this.hidLamps) ? this.hidLamps : [];

  if (this.settings.get('hidEnabled') > 0 && this.settings.supportsFeature('hid'))
  {
    for (var i = 0; i < hidLamps.length; ++i)
    {
      var hidLamp = hidLamps[i];

      if (!hidLampMap[hidLamp.nc12])
      {
        hidLampMap[hidLamp.nc12] = [];
        hidLampList.push({
          nc12: hidLamp.nc12,
          scanResults: hidLampMap[hidLamp.nc12]
        });
      }

      if (hidLamp.scanResult !== null)
      {
        hidLampMap[hidLamp.nc12].push(hidLamp.scanResult);
      }
    }
  }

  return hidLampList;
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
  this.hidLamps = null;
  this.waitingForLeds = false;
  this.waitingForHidLamps = false;
  this.waitingForContinue = null;
  this.inProgress = false;
  this.overallProgress = 0;

  Object.assign(this.weight, {
    scan: null,
    nc12: null,
    orderNo: null,
    component: null
  });

  this.clearGprs();
};

HistoryEntry.prototype.clearGprs = function()
{
  this.gprs = {
    item: null,
    orderData: null,
    driverData: null,
    gprsData: null,
    inputData: null,
    orderFile: null,
    inputTemplateFile: null,
    outputFile: null,
    orderFileContents: null,
    inputTemplateFileContents: null,
    inputFileContents: null,
    outputFileContents: null,
    orderFileHash: null,
    inputFileHash: null,
    outputFileHash: null
  };
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
  this.hidLamps = [];

  this.setUpProgram();
  this.setUpLeds();
  this.setUpHidLamps();

  this.waitingForLeds = this.settings.get('ledsEnabled') > 0
    && this.settings.supportsFeature('led')
    && this.leds.length > 0;
  this.waitingForHidLamps = this.settings.get('hidEnabled') > 0
    && this.settings.supportsFeature('hid')
    && this.hidLamps.length > 0;
  this.waitingForContinue = null;
  this.inProgress = true;
  this.overallProgress = 1;

  this.setUpGprs();

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

  if (this.settings.get('weightEnabled'))
  {
    this.log.push({
      time: this.startedAt,
      text: 'WEIGHT:STARTED'
    });
  }
  else if (this.waitingForHidLamps)
  {
    this.log.push({
      time: this.startedAt,
      text: 'HID:STARTED'
    });
  }
  if (this.settings.get('ftEnabled'))
  {
    this.log.push({
      time: this.startedAt,
      text: 'FT:STARTED'
    });
  }
  else if (_.isEmpty(this.nc12) && this.waitingForLeds && !this.program)
  {
    this.log.push({
      time: this.startedAt,
      text: 'LED_CHECKING_STARTED'
    });
  }
  else if (this.program)
  {
    this.log.push({
      time: this.startedAt,
      text: 'TESTING_WITH_PROGRAM_STARTED'
    });
  }
  else if (this.nc12)
  {
    this.log.push({
      time: this.startedAt,
      text: 'PROGRAMMING_STARTED',
      nc12: this.nc12
    });
  }
};

HistoryEntry.prototype.setUpProgram = function()
{
  if (this.settings.get('ftEnabled'))
  {
    this.program = {
      _id: '__FT__',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deleted: 0,
      type: 't24vdc',
      name: 'FT',
      steps: [
        {
          type: 'pe',
          enabled: true,
          startTime: 0,
          duration: this.settings.get('ftDuration') / 1000,
          voltage: this.settings.get('ftSetVoltage'),
          resistanceMax: this.settings.get('ftMaxResistance')
        }
      ],
      prodLines: ''
    };
  }

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

  this.metrics = null;

  if (this.program.type === 't24vdc'
    && !this.settings.get('ftEnabled')
    && !this.settings.get('hidEnabled')
    && !this.settings.get('weightEnabled'))
  {
    this.metrics = {
      uSet: [],
      uGet: [],
      i: []
    };
  }
};

HistoryEntry.prototype.setUpLeds = function()
{
  if (this.inputMode !== 'remote'
    || this.settings.get('ftEnabled')
    || this.settings.get('hidEnabled')
    || this.settings.get('weightEnabled'))
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
        raw: '',
        nc12: item.nc12,
        name: item.name,
        serialNumber: null,
        status: 'waiting' // waiting, checking, checked or an error object
      });
    }
  }
};

HistoryEntry.prototype.setUpHidLamps = function()
{
  if (this.inputMode !== 'remote'
    || this.settings.get('ftEnabled')
    || this.settings.get('ledsEnabled')
    || this.settings.get('weightEnabled'))
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

    if (item.kind !== 'hid')
    {
      continue;
    }

    var lampsPerResult = Math.floor(item.quantityTodo / orderData.quantityTodo);

    for (var ii = 0; ii < lampsPerResult; ++ii)
    {
      this.hidLamps.push({
        raw: '',
        nc12: item.nc12,
        name: item.name,
        scanResult: null,
        status: 'waiting' // waiting, checking, checked or an error object
      });
    }
  }
};

HistoryEntry.prototype.setUpGprs = function()
{
  this.clearGprs();

  if (!this.waitingForLeds
    || this.inputMode !== 'remote'
    || !this.settings.supportsFeature('gprs')
    || !this.settings.get('programming'))
  {
    return;
  }

  var orderData = this.getSelectedOrderData();

  if (!orderData)
  {
    return;
  }

  var gprsItem = null;

  for (var i = 0; i < orderData.items.length; ++i)
  {
    var item = orderData.items[i];

    if (item.kind === 'gprs')
    {
      gprsItem = item;

      break;
    }
  }

  if (gprsItem === null)
  {
    return;
  }

  var matches = gprsItem.name.match(/(F|T)(P|A)(_|A|B|C|D)/);

  if (matches !== null)
  {
    this.gprs.item = gprsItem;
    this.gprs.gprsData = {
      telemanagementMode: TELEMANAGEMENT_MODES[matches[1]],
      switchRegime: SWITCH_REGIMES[matches[2]],
      photoCellLevels: PHOTO_CELL_LEVELS[matches[3]]
    };
  }
};

HistoryEntry.prototype.hashFeatureFile = function()
{
  this.featureFileHash = typeof this.feature === 'string'
    ? createHash('md5').update(this.feature, 'utf8').digest('hex')
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

    step(
      function()
      {
        if (historyEntry.featureFileHash)
        {
          saveOnDisk(
            path.join(featureDbPath, historyEntry.featureFileHash),
            historyEntry.feature,
            this.group()
          );
        }

        if (historyEntry.gprs.orderFileContents)
        {
          var orderFileHash = createHash('md5').update(historyEntry.gprs.orderFileContents).digest('hex');

          historyEntry.gprs.orderFileHash = orderFileHash;

          saveOnDisk(
            path.join(featureDbPath, orderFileHash),
            historyEntry.gprs.orderFileContents,
            this.group()
          );
        }
      },
      function(err)
      {
        if (err)
        {
          return done(err);
        }

        return saveInDb(done);
      }
    );
  }

  function saveOnDisk(file, contents, done)
  {
    fs.writeFile(file, contents, {flag: 'wx'}, function(err)
    {
      if (err && err.code !== 'EEXIST')
      {
        return done(err);
      }

      return done();
    });
  }

  function saveInDb(done)
  {
    var sql = "\
      REPLACE INTO historyEntries (\
        _id, _order, nc12, counter, startedAt, finishedAt, duration,\
        log, result, errorCode, exception, output, featureFile,\
        featureFileName, featureFileHash, workflowFile, workflow,\
        program, steps, metrics, serviceTag, leds, hidLamps, prodLine,\
        gprsNc12, gprsOrderFileHash, gprsInputFileHash, gprsOutputFileHash\
      ) VALUES (\
        $_id, $_order, $nc12, $counter, $startedAt, $finishedAt, $duration,\
        $log, $result, $errorCode, $exception, $output, $featureFile,\
        $featureFileName, $featureFileHash, $workflowFile, $workflow,\
        $program, $steps, $metrics, $serviceTag, $leds, $hidLamps, $prodLine,\
        $gprsNc12, $gprsOrderFileHash, $gprsInputFileHash, $gprsOutputFileHash\
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
      $leds: Array.isArray(historyEntry.leds) && historyEntry.leds.length
        ? JSON.stringify(historyEntry.leds)
        : null,
      $hidLamps: Array.isArray(historyEntry.hidLamps) && historyEntry.hidLamps.length
        ? JSON.stringify(historyEntry.hidLamps)
        : null,
      $prodLine: historyEntry.settings.get('prodLine') || null,
      $gprsNc12: historyEntry.gprs.item ? historyEntry.gprs.item.nc12 : null,
      $gprsOrderFileHash: historyEntry.gprs.orderFileHash,
      $gprsInputFileHash: historyEntry.gprs.inputFileHash,
      $gprsOutputFileHash: historyEntry.gprs.outputFileHash
    };

    historyEntry.db.run(sql, params, done);
  }
};
