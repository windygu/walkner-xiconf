// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

/*jshint unused:false*/

'use strict';

var CR = 0x0D;
var A = 0x41;
var B = 0x42;
var C = 0x43;
var D = 0x44;
var E = 0x45;
var F = 0x46;
var G = 0x47;
var H = 0x48;
var I = 0x49;
var J = 0x4A;
var K = 0x4B;
var L = 0x4C;
var M = 0x4D;
var N = 0x4E;
var O = 0x4F;
var P = 0x50;
var Q = 0x51;
var R = 0x52;
var S = 0x53;
var T = 0x54;
var U = 0x55;
var V = 0x56;
var W = 0x57;
var X = 0x58;
var Y = 0x59;
var Z = 0x60;

function high(theByte)
{
  return ((theByte & 0xF0) >>> 4) & 0xFF;
}

function low(theByte)
{
  return ((theByte & 0x0F) >>> 0) & 0xFF;
}

function encodeNibble(nibble)
{
  return nibble + (nibble < 10 ? 48 : 55);
}

function ok(buffer)
{
  var index = buffer.length - 3;

  return buffer[index] === O && buffer[index + 1] === K && buffer[index + 2] === CR;
}

function frameRequest(req, address)
{
  var addrHigh;
  var addrLow;

  if (!address)
  {
    addrHigh = 0x00;
    addrLow = 0x00;
  }
  else
  {
    addrHigh = encodeNibble(high(address));
    addrLow = encodeNibble(low(address));
  }

  if (req.length === 4)
  {
    req.push(addrHigh, addrLow);
  }
  else
  {
    req[4] = addrHigh;
    req[5] = addrLow;
  }

  req.push(CR);

  return new Buffer(req);
}

module.exports = {

  // Disable front panel keypad and enter Remote Mode
  SESS: function(address)
  {
    return {
      request: frameRequest([S, E, S, S], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };

  },

  // Enable front panel keypad and exit Remote Mode
  ENDS: function(address)
  {
    return {
      request: frameRequest([E, N, D, S], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Get the RS-485 address
  GCOM: function(address)
  {
    return {
      request: frameRequest([G, C, O, M], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Get maximum voltage and current
  GMAX: function(address)
  {
    return {
      request: frameRequest([G, M, A, X], address),
      responseLength: 7 + 3,
      response: function(buffer)
      {
        if (buffer[6] !== CR || !ok(buffer))
        {
          return null;
        }

        buffer = buffer.toString('ascii');

        return {
          voltage: (parseInt(buffer.substr(0, 3), 10) || 0) / 10,
          current: (parseInt(buffer.substr(3, 3), 10) || 0) / 100
        };
      }
    };
  },

  // Get the upper voltage limit
  GOVP: function(address)
  {
    return {
      request: frameRequest([G, O, V, P], address),
      responseLength: 4 + 3,
      response: function(buffer)
      {
        if (buffer[4] !== CR || !ok(buffer))
        {
          return null;
        }

        buffer = buffer.toString('ascii');

        return {
          voltage: (parseInt(buffer.substr(0, 3), 10) || 0) / 10
        };
      }
    };
  },

  // Get voltage and current readings
  GETD: function(address)
  {
    return {
      request: frameRequest([G, E, T, D], address),
      responseLength: 10 + 3,
      response: function(buffer)
      {
        if (buffer[9] !== CR || !ok(buffer))
        {
          return null;
        }

        buffer = buffer.toString('ascii');

        var mode = buffer.substr(8, 1);

        if (mode === '1')
        {
          mode = 'CC';
        }
        else if (mode === '0')
        {
          mode = 'CV';
        }
        else
        {
          return null;
        }

        return {
          voltage: (parseInt(buffer.substr(0, 4), 10) || 0) / 100,
          current: (parseInt(buffer.substr(4, 4), 10) || 0) / 1000,
          mode: mode
        };
      }
    };
  },

  // Get voltage and current set value
  GETS: function(address)
  {
    return {
      request: frameRequest([G, E, T, S], address),
      responseLength: 7 + 3,
      response: function(buffer)
      {
        if (buffer[6] !== CR || !ok(buffer))
        {
          return null;
        }

        buffer = buffer.toString('ascii');

        return {
          voltage: (parseInt(buffer.substr(0, 3), 10) || 0) / 10,
          current: (parseInt(buffer.substr(3, 3), 10) || 0) / 100
        };
      }
    };
  },

  // Get preset memory values
  GETM: function(address, location)
  {
    if (location >= 1 && location <= 9)
    {
      return {
        request: frameRequest([G, E, T, M, 0, 0, encodeNibble(location)], address),
        responseLength: 7 + 3,
        response: function(buffer)
        {
          if (!ok(buffer))
          {
            return null;
          }

          buffer = buffer.toString('ascii');

          return {
            voltage: (parseInt(buffer.substr(0, 3), 10) || 0) / 10,
            current: (parseInt(buffer.substr(3, 3), 10) || 0) / 100
          };
        }
      };
    }

    return {
      request: frameRequest([G, E, T, M], address),
      responseLength: 7 * 9 + 3,
      response: function(buffer)
      {
        if (!ok(buffer))
        {
          return null;
        }

        buffer = buffer.toString('ascii');

        var res = {
          voltage: [],
          current: []
        };

        for (var i = 0; i < 9; ++i)
        {
          res.voltage.push((parseInt(buffer.substr(7 * i, 3), 10) || 0) / 10);
          res.current.push((parseInt(buffer.substr(7 * i + 3, 3), 10) || 0) / 100);
        }

        return res;
      }
    };
  },

  // Get timed program memory
  GETP: function(address, program)
  {
    if (program >= 0 && program <= 19)
    {
      var programHigh;
      var programLow;

      if (program < 10)
      {
        programHigh = 0;
        programLow = program;
      }
      else
      {
        programHigh = 1;
        programLow = program - 10;
      }

      return {
        request: frameRequest([G, E, T, P, 0, 0, encodeNibble(programHigh), encodeNibble(programLow)], address),
        responseLength: 11 + 3,
        response: function(buffer)
        {
          if (!ok(buffer))
          {
            return null;
          }

          buffer = buffer.toString('ascii');

          return {
            voltage: (parseInt(buffer.substr(0, 3), 10) || 0) / 10,
            current: (parseInt(buffer.substr(3, 3), 10) || 0) / 100,
            minute: parseInt(buffer.substr(6, 2), 10) || 0,
            second: parseInt(buffer.substr(8, 2), 10) || 0
          };
        }
      };
    }

    return {
      request: frameRequest([G, E, T, P], address),
      responseLength: 11 * 20 + 3,
      response: function(buffer)
      {
        if (!ok(buffer))
        {
          return null;
        }

        buffer = buffer.toString('ascii');

        var res = {
          voltage: [],
          current: [],
          minute: [],
          second: []
        };

        for (var i = 0; i < 20; ++i)
        {
          res.voltage.push((parseInt(buffer.substr(11 * i, 3), 10) || 0) / 10);
          res.current.push((parseInt(buffer.substr(11 * i + 3, 3), 10) || 0) / 100);
          res.minute.push(parseInt(buffer.substr(11 * i + 6, 2), 10) || 0);
          res.second.push(parseInt(buffer.substr(11 * i + 8, 2), 10) || 0);
        }

        return res;
      }
    };
  },

  // Get LCD display information
  GPAL: function(address)
  {
    return {
      request: frameRequest([G, P, A, L], address),
      responseLength: 6 + 6 + 6 + 14 + 9 + 9 + 5 + 10 + 4 + 3,
      response: function(buffer)
      {
        return ok(buffer) ? buffer : null;
      }
    };
  },

  // Set voltage level
  VOLT: function(address, voltage)
  {
    if (voltage < 0)
    {
      voltage = 0;
    }
    else if (voltage >= 100)
    {
      voltage = 99.9;
    }

    voltage = Math.floor(voltage * 10);

    var hundreds = Math.floor(voltage / 100);
    var tens = Math.floor(voltage % 100 / 10);
    var ones = voltage % 10;

    return {
      request: frameRequest(
        [V, O, L, T, 0, 0, encodeNibble(hundreds), encodeNibble(tens), encodeNibble(ones)],
        address
      ),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Set current level
  CURR: function(address, current)
  {
    if (current < 0)
    {
      current = 0;
    }
    else if (current >= 10)
    {
      current = 9.99;
    }

    current = Math.floor(current * 100);

    var hundreds = Math.floor(current / 100);
    var tens = Math.floor(current % 100 / 10);
    var ones = current % 10;

    return {
      request: frameRequest(
        [C, U, R, R, 0, 0, encodeNibble(hundreds), encodeNibble(tens), encodeNibble(ones)],
        address
      ),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Set upper voltage limit
  SOVP: function(address, voltage)
  {
    if (voltage < 0)
    {
      voltage = 0;
    }
    else if (voltage >= 100)
    {
      voltage = 99.9;
    }

    voltage = Math.floor(voltage * 10);

    var hundreds = Math.floor(voltage / 100);
    var tens = Math.floor(voltage % 100 / 10);
    var ones = voltage % 10;

    return {
      request: frameRequest(
        [S, O, V, P, 0, 0, encodeNibble(hundreds), encodeNibble(tens), encodeNibble(ones)],
        address
      ),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Toggle output
  SOUT: function(address, state)
  {
    return {
      request: frameRequest([S, O, U, T, 0, 0, encodeNibble(state ? 0 : 1)], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Toggle output when PS is switched on
  POWW: function(address, location, state)
  {
    if (location < 1)
    {
      location = 1;
    }
    else if (location > 9)
    {
      location = 9;
    }

    return {
      request: frameRequest([P, O, W, W, 0, 0, encodeNibble(location), encodeNibble(state ? 1 : 0)], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Set voltage and current values of preset memory
  PROM: function(address, location, voltage, current)
  {
    if (location < 1)
    {
      location = 1;
    }
    else if (location > 9)
    {
      location = 9;
    }

    if (voltage < 0)
    {
      voltage = 0;
    }
    else if (voltage >= 100)
    {
      voltage = 99.9;
    }

    voltage = Math.floor(voltage * 10);

    var vHundreds = Math.floor(voltage / 100);
    var vTens = Math.floor(voltage % 100 / 10);
    var vOnes = voltage % 10;

    if (current < 0)
    {
      current = 0;
    }
    else if (current >= 10)
    {
      current = 9.99;
    }

    current = Math.floor(current * 100);

    var cHundreds = Math.floor(current / 100);
    var cTens = Math.floor(current % 100 / 10);
    var cOnes = current % 10;

    return {
      request: frameRequest([
        P, R, O, M, 0, 0,
        encodeNibble(location),
        encodeNibble(vHundreds), encodeNibble(vTens), encodeNibble(vOnes),
        encodeNibble(cHundreds), encodeNibble(cTens), encodeNibble(cOnes)
      ], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Set voltage, current and time period of timed program
  PROP: function(address, location, voltage, current, minute, second)
  {
    if (location < 0)
    {
      location = 0;
    }
    else if (location > 19)
    {
      location = 19;
    }

    var lTens = Math.floor(second / 10);
    var lOnes = second % 10;

    if (voltage < 0)
    {
      voltage = 0;
    }
    else if (voltage >= 100)
    {
      voltage = 99.9;
    }

    voltage = Math.floor(voltage * 10);

    var vHundreds = Math.floor(voltage / 100);
    var vTens = Math.floor(voltage % 100 / 10);
    var vOnes = voltage % 10;

    if (current < 0)
    {
      current = 0;
    }
    else if (current >= 10)
    {
      current = 9.99;
    }

    current = Math.floor(current * 100);

    var cHundreds = Math.floor(current / 100);
    var cTens = Math.floor(current % 100 / 10);
    var cOnes = current % 10;

    if (minute < 0)
    {
      minute = 0;
    }
    else if (minute > 59)
    {
      minute = 59;
    }

    var mTens = Math.floor(minute / 10);
    var mOnes = minute % 10;

    if (second < 0)
    {
      second = 0;
    }
    else if (second > 59)
    {
      second = 59;
    }

    var sTens = Math.floor(second / 10);
    var sOnes = second % 10;

    return {
      request: frameRequest([
        P, R, O, P, 0, 0,
        encodeNibble(lTens), encodeNibble(lOnes),
        encodeNibble(vHundreds), encodeNibble(vTens), encodeNibble(vOnes),
        encodeNibble(cHundreds), encodeNibble(cTens), encodeNibble(cOnes),
        encodeNibble(mTens), encodeNibble(mOnes),
        encodeNibble(sTens), encodeNibble(sOnes)
      ], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Recall preset memory
  RUNM: function(address, location)
  {
    if (location < 1)
    {
      location = 1;
    }
    else if (location > 9)
    {
      location = 9;
    }

    return {
      request: frameRequest([R, U, N, M, 0, 0, encodeNibble(location)], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Run timed program
  RUNP: function(address, times)
  {
    if (times < 0)
    {
      times = 0;
    }
    else if (times > 256)
    {
      times = 256;
    }

    var hundreds = Math.floor(times / 100);
    var tens = Math.floor(times % 100 / 10);
    var ones = times % 10;

    return {
      request: frameRequest(
        [R, U, N, P, 0, 0, encodeNibble(hundreds), encodeNibble(tens), encodeNibble(ones)],
        address
      ),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  },

  // Stop timed program
  STOP: function(address)
  {
    return {
      request: frameRequest([S, T, O, P], address),
      responseLength: 3,
      response: function(buffer)
      {
        return ok(buffer) ? {} : null;
      }
    };
  }

};
