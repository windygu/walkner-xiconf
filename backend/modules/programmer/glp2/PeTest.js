// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var util = require('./util');
var ProgramStep = require('./ProgramStep');

module.exports = PeTest;

/**
 * @constructor
 * @param {object} options
 * @param {string} [options.label]
 * @param {number} options.step
 * @param {number} options.setValue
 * @param {number} options.duration
 * @param {boolean} options.directConnection
 * @param {boolean} options.startOnTouch
 * @param {number} options.ipr
 * @param {boolean} options.multi
 * @param {number} options.u
 * @param {boolean} options.buzzer
 * @param {boolean} options.setProbe
 * @param {number} options.retries
 * @param {boolean} options.cancelOnFailure
 * @param {boolean} options.enabled
 * @param {number} options.minSetValue
 * @throws {Error}
 */
function PeTest(options)
{
  ProgramStep.call(this, options);

  util.validateNumber('setValue', options.setValue, 0.01, 3);
  util.validateNumber('duration', options.duration, 0, 60);
  util.validateBool('directConnection', options.directConnection);
  util.validateBool('startOnTouch', options.startOnTouch);
  util.validateNumber('ipr', options.ipr, 10, 30);
  util.validateBool('multi', options.multi);
  util.validateEnum('u', options.u, [6, 12]);
  util.validateBool('buzzer', options.buzzer);
  util.validateBool('setProbe', options.setProbe);
  util.validateNumber('retries', options.retries, 0, 5);
  util.validateBool('cancelOnFailure', options.cancelOnFailure);
  util.validateBool('enabled', options.enabled);
  util.validateNumber('minSetValue', options.minSetValue, 0, 2);

  this.setValue = Math.round(options.setValue * 100) / 100;
  this.duration = options.duration;
  this.directConnection = util.bool(options.directConnection);
  this.startOnTouch = util.bool(options.startOnTouch);
  this.ipr = Math.floor(options.ipr);
  this.multi = util.bool(options.multi);
  this.u = options.u === 12 ? 1 : 0;
  this.buzzer = util.bool(options.buzzer);
  this.setProbe = util.bool(options.setProbe);
  this.retries = Math.floor(options.retries);
  this.cancelOnFailure = util.bool(options.cancelOnFailure);
  this.enabled = util.bool(options.enabled);
  this.minSetValue = Math.round(options.minSetValue * 100) / 100;
}

util.inherits(PeTest, ProgramStep);

/**
 * @returns {PeTest}
 */
PeTest.fromObject = function(obj)
{
  if (obj instanceof PeTest)
  {
    return obj;
  }

  return new PeTest(obj);
};

/**
 * @returns {number}
 */
PeTest.prototype.getTotalTime = function()
{
  return this.duration * 1000;
};

/**
 * @param {number} [step]
 * @returns {string}
 */
PeTest.prototype.serializeCommand = function(step)
{
  return 'S9-' + [
    step || this.step,
    this.setValue.toFixed(2),
    Math.floor(this.duration * 1000),
    this.directConnection,
    this.startOnTouch,
    this.ipr,
    this.multi,
    this.u,
    this.buzzer,
    this.setProbe,
    this.retries,
    this.cancelOnFailure,
    this.enabled ? 0 : 1,
    this.minSetValue.toFixed(2)
  ].join('_');
};
