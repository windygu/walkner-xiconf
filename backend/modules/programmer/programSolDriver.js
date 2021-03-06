// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var SerialPort = require('serialport');
var step = require('h5.step');

var EOF_DELAY = 250;
var PROPERTY_PARSERS = {
  'historysize': createSingleNumberParser('historysize', 0, 366),
  'history': createDoubleNumberParser('history', 0, 366, 0, 1440),
  'reqnights': createSingleNumberParser('reqnights', 0, 366),
  'minnightdur': createSingleNumberParser('minnightdur', 0, 1440),
  'maxnightdur': createSingleNumberParser('maxnightdur', 0, 1440),
  'maxnightdelta': createSingleNumberParser('maxnightdelta', 0, 1440),
  'periodsize': createSingleNumberParser('periodsize', 0, 16),
  'dimlevel': createDoubleNumberParser('dimlevel', 0, 16, 0, 0xFFFF),
  'dimdur': createDoubleNumberParser('dimdur', 0, 15, -0xFFFF, 0xFFFF),
  'fadetime': createSingleNumberParser('fadetime', 0, 536)
};

module.exports = function programSolDriver(app, programmerModule, output, onProgress, done)
{
  var settings = app[programmerModule.config.settingsId];
  var currentState = programmerModule.currentState;
  var commands = [];

  programmerModule.log('SOL_STARTED');

  if (!settings.supportsFeature('sol'))
  {
    return done('SOL_FEATURE_DISABLED');
  }

  try
  {
    commands = parseProgram(currentState.feature);
  }
  catch (err)
  {
    programmerModule.log('SOL_PARSE_ERROR', err);

    return done('SOL_PARSE_ERROR');
  }

  if (commands.length === 0)
  {
    return done('SOL_NO_COMMANDS');
  }

  var fake = app.options.env !== 'production';
  var allCommandCount = 4 + commands.length * 4 + (settings.get('solReset') ? 2 : 0);
  var completedCommandCount = 0;

  function progress()
  {
    ++completedCommandCount;

    if (typeof onProgress === 'function')
    {
      onProgress(Math.round(completedCommandCount * 100 / allCommandCount));
    }
  }

  step(
    function findComPortStep()
    {
      /*jshint validthis:true*/

      var comPattern = settings.get('solComPattern');

      programmerModule.log('SOL_SEARCHING_COM', {pattern: comPattern});

      var next = this.next();

      SerialPort.list(function(err, ports)
      {
        if (err)
        {
          return next(err);
        }

        for (var i = 0, l = ports.length; i < l; ++i)
        {
          var port = ports[i];
          var keys = Object.keys(port);

          for (var ii = 0, ll = keys.length; ii < ll; ++ii)
          {
            var key = keys[ii];

            if (typeof port[key] === 'string' && port[key].indexOf(comPattern) !== -1)
            {
              return next(null, port.comName);
            }
          }
        }

        return next(null, null);
      });
    },
    function openComPortStep(err, comPort)
    {
      /*jshint validthis:true*/

      if (programmerModule.cancelled)
      {
        return this.skip('CANCELLED');
      }

      if (err)
      {
        err.code = 'SOL_SEARCHING_COM_FAILURE';

        return this.skip(err);
      }

      if (comPort === null)
      {
        return this.skip('SOL_COM_NOT_FOUND');
      }

      programmerModule.log('SOL_OPENING_COM', {comPort: comPort});

      var serialPort = this.serialPort = new SerialPort(comPort, {
        baudRate: 1200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false
      });

      serialPort.on('error', function(err)
      {
        if (!serialPort.errored)
        {
          serialPort.errored = err;
        }
      });

      serialPort.open(this.next());
    },
    function setNumberBaseStep(err)
    {
      if (programmerModule.cancelled)
      {
        return this.skip('CANCELLED');
      }

      if (this.serialPort.errored)
      {
        return this.skip();
      }

      if (err)
      {
        err.code = 'SOL_OPENING_COM_FAILURE';

        return this.skip(err);
      }

      this.output = output || [];

      var next = this.next();

      execCommand(programmerModule, this.serialPort, this.output, 'set base 10', progress, function(err, result)
      {
        return next(result === '10' || fake ? null : 'SOL_NO_CONNECTION');
      });
    },
    function execSetCommandsStep(err)
    {
      if (programmerModule.cancelled)
      {
        return this.skip('CANCELLED');
      }

      if (this.serialPort.errored)
      {
        return this.skip();
      }

      if (err)
      {
        return this.skip(err);
      }

      programmerModule.log('SOL_EXECUTING_SET_COMMANDS', {count: commands.length});

      var steps = [];

      for (var i = 0, l = commands.length; i < l; ++i)
      {
        steps.push(createExecSetCommandStep(programmerModule, this.serialPort, this.output, commands[i], progress));
      }

      steps.push(this.next());

      step(steps);
    },
    function resetDeviceStep()
    {
      if (programmerModule.cancelled)
      {
        return this.skip('CANCELLED');
      }

      if (this.serialPort.errored)
      {
        return this.skip();
      }

      if (!settings.get('solReset'))
      {
        return;
      }

      programmerModule.log('SOL_RESETTING');

      var next = this.next();
      var resetDelay = parseInt(settings.get('solResetDelay'), 10);

      if (isNaN(resetDelay))
      {
        resetDelay = 2000;
      }
      else if (resetDelay < 333)
      {
        resetDelay = 333;
      }

      execCommand(
        programmerModule,
        this.serialPort,
        this.output,
        'do reset',
        progress,
        setTimeout.bind(null, next, resetDelay)
      );
    },
    function execGetCommandsStep()
    {
      if (programmerModule.cancelled)
      {
        return this.skip('CANCELLED');
      }

      if (this.serialPort.errored)
      {
        return this.skip();
      }

      programmerModule.log('SOL_EXECUTING_GET_COMMANDS');

      var steps = [
        createExecGetCommandStep(fake, programmerModule, this.serialPort, this.output, {
          option: 'version',
          setCmd: null,
          getCmd: 'get version',
          result: null
        }, progress)
      ];

      for (var i = 0, l = commands.length; i < l; ++i)
      {
        steps.push(
          createExecGetCommandStep(fake, programmerModule, this.serialPort, this.output, commands[i], progress)
        );
      }

      steps.push(this.next());

      step(steps);
    },
    function closeComPortStep(err)
    {
      if (!output && Array.isArray(this.output))
      {
        programmerModule.changeState({
          output: this.output.join('\n')
        });

        this.output = null;
      }

      var serialPort = this.serialPort;

      if (serialPort)
      {
        this.serialPort = null;

        if (!err && serialPort.errored)
        {
          err = serialPort.errored;
          err.code = 'SOL_SERIAL_PORT_FAILURE';
        }

        serialPort.removeAllListeners();
        serialPort.on('error', function() {});
        serialPort.close(function() {});
        serialPort = null;
      }

      setImmediate(function() { done(err); });
    }
  );
};

function createExecSetCommandStep(programmerModule, serialPort, output, command, progress)
{
  return function execSetCommandStep()
  {
    if (programmerModule.cancelled)
    {
      return this.skip('CANCELLED');
    }

    if (serialPort.errored)
    {
      return this.skip();
    }

    execCommand(programmerModule, serialPort, output, command.setCmd, progress, this.next());
  };
}

function createExecGetCommandStep(fake, programmerModule, serialPort, output, command, progress)
{
  return function execGetCommandStep(err)
  {
    if (programmerModule.cancelled)
    {
      return this.skip('CANCELLED');
    }

    if (serialPort.errored || err)
    {
      return this.skip(err);
    }

    var next = this.next();

    execCommand(programmerModule, serialPort, output, command.getCmd, progress, function(err, result)
    {
      if (!fake && command.result !== null && String(command.result) !== result)
      {
        programmerModule.log('SOL_INVALID_OPTION', {
          option: command.option,
          expected: command.result,
          actual: result
        });

        return next('SOL_INVALID_OPTION');
      }

      return next();
    });
  };
}

function execCommand(programmerModule, serialPort, output, cmd, progress, done)
{
  output.push('[SOL] TX: ' + cmd);

  var buffers = [];
  var totalLength = 0;
  var eofTimer = null;

  serialPort.on('data', function(data)
  {
    buffers.push(data);
    totalLength += data.length;

    if (programmerModule.cancelled || serialPort.errored)
    {
      finalize();
    }
    else
    {
      restartEofTimer();
    }
  });

  serialPort.write(new Buffer(cmd + '\r', 'ascii'));

  progress();
  restartEofTimer();

  function restartEofTimer()
  {
    clearTimeout(eofTimer);
    eofTimer = setTimeout(finalize, EOF_DELAY);
  }

  function finalize()
  {
    clearTimeout(eofTimer);
    eofTimer = null;

    serialPort.removeAllListeners('data');

    var result = '';

    Buffer.concat(buffers, totalLength).toString('ascii').split('\r').forEach(function(line)
    {
      line = line.trim();

      if (line.length > 0)
      {
        result += line + '\n';

        output.push('[SOL] RX: ' + line);
      }
    });

    progress();
    done(null, result.trim());
  }
}

function parseProgram(source)
{
  return source
    .replace(/\r/g, '\n')
    .split(/\n+/)
    .map(parseCommand)
    .filter(function(cmd) { return cmd !== null; });
}

function parseCommand(line, i)
{
  var args = line.trim().split(/\s+/);
  var name = args.shift();
  var prop = args.shift();

  if (name === 'set' && PROPERTY_PARSERS[prop])
  {
    return PROPERTY_PARSERS[prop](line, i, args);
  }

  return null;
}

function throwParseError(line, i, prop)
{
  throw {
    line: line,
    i: i + 1,
    prop: prop
  };
}

function createSingleNumberParser(option, minValue, maxValue)
{
  return function parseSingleNumber(line, i, args)
  {
    var value = parseInt(args[0]);

    if (isNaN(value) || value < (minValue || 0) || value > (maxValue || 0xFFFF))
    {
      throwParseError(line, i, option);
    }

    return {
      option: option,
      setCmd: 'set ' + option + ' ' + value,
      getCmd: 'get ' + option,
      result: value
    };
  };
}

function createDoubleNumberParser(option, minIndex, maxIndex, minValue, maxValue)
{
  return function parseDimLevel(line, i, args)
  {
    var index = parseInt(args[0]);

    if (isNaN(index) || index < (minIndex || 0) || index > (maxIndex || 0xFF))
    {
      throwParseError(line, i, option);
    }

    var value = args[1];

    if (/^[0-9]+(\.[0-9]+)?%$/.test(value))
    {
      value = Math.round(parseFloat(value) * (maxValue || 0xFFFF) / 100);
    }
    else
    {
      value = parseInt(value);
    }

    if (isNaN(value) || value < (minValue || 0) || value > (maxValue || 0xFFFF))
    {
      throwParseError(line, i, option);
    }

    return {
      option: option + ' ' + index,
      setCmd: 'set ' + option + ' ' + index + ' ' + value,
      getCmd: 'get ' + option + ' ' + index,
      result: value
    };
  };
}
