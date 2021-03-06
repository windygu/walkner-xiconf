// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var fs = require('fs');
var path = require('path');
var moment = require('moment');
var csv = require('csv');
var step = require('h5.step');
var _ = require('lodash');

module.exports = function setUpHistoryRoutes(app, historyModule)
{
  var TERM_TO_CONDITION = {
    eq: '=',
    ne: '<>',
    lt: '<',
    le: '<=',
    gt: '>',
    ge: '>=',
    in: true
  };
  var PROPERTY_TO_FIELD = {
    _id: 'e._id',
    _order: 'e._order',
    serviceTag: 'e.serviceTag',
    nc12: 'e.nc12',
    counter: 'e.counter',
    startedAt: 'e.startedAt',
    finishedAt: 'e.finishedAt',
    duration: 'e.duration',
    result: 'e.result',
    errorCode: 'e.errorCode',
    exception: 'e.exception',
    featureFileName: 'e.featureFileName',
    gprsNc12: 'e.gprsNc12',
    gprsOrderFileHash: 'e.gprsOrderFileHash',
    gprsInputFileHash: 'e.gprsInputFileHash',
    gprsOutputFileHash: 'e.gprsOutputFileHash',
    program: 'e.program',
    steps: 'e.steps',
    metrics: 'e.metrics',
    cancelled: 'e.cancelled',
    quantity: 'o.quantity',
    no: 'o.no',
    successCounter: 'o.successCounter',
    failureCounter: 'o.failureCounter',
    orderStartedAt: 'o.startedAt AS orderStartedAt',
    orderFinishedAt: 'o.finishedAt AS orderFinishedAt',
    orderDuration: 'o.duration AS orderDuration'
  };

  var express = app[historyModule.config.expressId];
  var db = app[historyModule.config.sqlite3Id].db;

  express.get('/history', prepareSql, function(req, res, next)
  {
    step(
      function()
      {
        var sql = "SELECT COUNT(*) AS totalCount\
                   FROM historyEntries e\
                   LEFT JOIN orders o ON o._id=e._order\
                   WHERE " + req.sql.conditions;

        db.get(sql, this.next());
      },
      function(err, row)
      {
        if (err)
        {
          return this.skip(err);
        }

        this.totalCount = row.totalCount;

        if (row.totalCount === 0)
        {
          return this.skip(null, []);
        }
      },
      function()
      {
        var sql = "SELECT " + req.sql.fields + "\
                   FROM historyEntries e\
                   LEFT JOIN orders o ON o._id=e._order\
                   WHERE " + req.sql.conditions + "\
                   ORDER BY " + req.sql.orderBy + "\
                   LIMIT " + req.sql.limit + " OFFSET " + req.sql.offset;

        db.all(sql, this.next());
      },
      function(err, rows)
      {
        if (err)
        {
          return next(err);
        }

        res.send({
          totalCount: this.totalCount,
          collection: rows
        });
      }
    );
  });

  express.get('/history;export', setExportFields, prepareSql, function(req, res, next)
  {
    var sql = "SELECT " + req.sql.fields + "\
               FROM historyEntries e\
               LEFT JOIN orders o ON o._id=e._order\
               WHERE " + req.sql.conditions + "\
               ORDER BY " + req.sql.orderBy;

    db.all(sql, function(err, rows)
    {
      if (err)
      {
        return next(err);
      }

      res.type('csv');
      res.attachment('xiconf-results.csv');

      if (rows.length === 0)
      {
        return res.end();
      }

      res.write(new Buffer([0xEF, 0xBB, 0xBF]));

      csv()
        .from.array(rows)
        .to.stream(res, {
          header: true,
          columns: Object.keys(rows[0]),
          rowDelimiter: '\r\n',
          delimiter: ';',
          quote: '"'
        })
        .transform(function(row)
        {
          formatDateTime(row, 'startedAt');
          formatDateTime(row, 'finishedAt');
          formatDateTime(row, 'orderStartedAt');
          formatDateTime(row, 'orderFinishedAt');
          formatDuration(row, 'duration');
          formatDuration(row, 'orderDuration');

          return row;
        })
        .on('error', next);
    });
  });

  express.get('/history;recent', function(req, res)
  {
    res.send({
      totalCount: historyModule.recent.length,
      collection: historyModule.recent
    });
  });

  express.get('/history/:id;workflow', downloadFileRoute.bind(null, 'workflow'));
  express.get('/history/:id;feature', downloadFileRoute.bind(null, 'feature'));
  express.get('/history/:id;gprsOrder', downloadFileRoute.bind(null, 'gprsOrder'));
  express.get('/history/:id;gprsInput', downloadFileRoute.bind(null, 'gprsInput'));
  express.get('/history/:id;gprsOutput', downloadFileRoute.bind(null, 'gprsOutput'));

  express.get('/history/:id', function(req, res, next)
  {
    var sql = "SELECT e.*, o.startedAt AS orderStartedAt, o.finishedAt AS orderFinishedAt,\
                      o.successCounter, o.failureCounter, o.no, o.quantity,\
                      o.duration AS orderDuration\
               FROM historyEntries e\
               LEFT JOIN orders o ON o._id=e._order\
               WHERE e._id=$_id\
               LIMIT 1";

    db.get(sql, {$_id: req.params.id}, function(err, row)
    {
      if (err)
      {
        return next(err);
      }

      if (!row)
      {
        return res.sendStatus(404);
      }

      if (row.program)
      {
        row.program = JSON.parse(row.program);
      }

      if (row.steps)
      {
        row.steps = JSON.parse(row.steps);
      }

      if (row.metrics)
      {
        row.metrics = JSON.parse(row.metrics);
      }

      step(
        function()
        {
          readFileContents(row, 'feature', row.featureFileHash, this.group());
          readFileContents(row, 'gprsOrderFile', row.gprsOrderFileHash, this.group());
          readFileContents(row, 'gprsInputFile', row.gprsInputFileHash, this.group());
          readFileContents(row, 'gprsOutputFile', row.gprsOutputFileHash, this.group());
        },
        function()
        {
          res.json(row);
        }
      );
    });
  });

  function readFileContents(obj, property, fileHash, done)
  {
    if (!fileHash)
    {
      return setImmediate(done);
    }

    var featureFile = path.join(historyModule.config.featureDbPath, fileHash);

    fs.readFile(featureFile, 'utf8', function(err, fileContents)
    {
      if (err)
      {
        historyModule.error("Failed to read file contents of [%s]: %s", obj._id, err.message);
      }
      else
      {
        obj[property] = fileContents;
      }

      return done();
    });
  }

  function downloadFileRoute(file, req, res, next)
  {
    var sql = "SELECT e.*, o.no AS orderNo\
               FROM historyEntries e\
               LEFT JOIN orders o ON o._id=e._order\
               WHERE e._id=$_id\
               LIMIT 1";

    db.get(sql, {$_id: req.params.id}, function(err, row)
    {
      if (err)
      {
        return next(err);
      }

      if (!row)
      {
        return res.sendStatus(404);
      }

      var startedAtMoment = moment(row.startedAt);
      var suffix = '_' + startedAtMoment.format('YYYY-MM-DD');
      var startedAtHour = startedAtMoment.hour();

      if (startedAtHour >= 6 && startedAtHour < 14)
      {
        suffix += '_I';
      }
      else if (startedAtHour >= 14 && startedAtHour < 22)
      {
        suffix += '_II';
      }
      else
      {
        suffix += '_III';
      }

      var type;
      var filename;
      var fileHash;

      if (file === 'feature')
      {
        type = 'xml';
        suffix += '.xml';

        if (typeof row.featureFileName === 'string')
        {
          filename = 'FEATURE_' + row.featureFileName.replace(/\.xml$/i, suffix);
        }
        else
        {
          filename = 'FEATURE' + suffix;
        }

        fileHash = row.featureFileHash;
      }
      else if (file === 'gprsOrder')
      {
        type = 'txt';
        suffix += '.dat';
        filename = row.orderNo + suffix;
        fileHash = row.gprsOrderFileHash;
      }
      else if (file === 'gprsInput')
      {
        type = 'json';
        suffix += '.json';
        filename = (row.serviceTag || '').replace(/^P0+/, '') + suffix;
        fileHash = row.gprsInputFileHash;
      }
      else if (file === 'gprsOutput')
      {
        type = 'xml';
        suffix += '.xml';
        filename = (row.serviceTag || '').replace(/^P0+/, '') + suffix;
        fileHash = row.gprsOutputFileHash;
      }
      else
      {
        type = 'txt';
        suffix += '.txt';
        filename = 'WORKFLOW_' + suffix;
      }

      res.type(type);
      res.attachment(filename);

      if (file === 'workflow')
      {
        return res.send(row.workflow);
      }

      if (fileHash)
      {
        return res.sendFile(path.join(historyModule.config.featureDbPath, fileHash));
      }

      res.send('?');
    });
  }

  function setExportFields(req, res, next)
  {
    req.rql.fields = {
      serviceTag: 1,
      no: 1,
      nc12: 1,
      gprsNc12: 1,
      counter: 1,
      quantity: 1,
      result: 1,
      errorCode: 1,
      exception: 1,
      featureFileName: 1,
      startedAt: 1,
      finishedAt: 1,
      duration: 1,
      orderStartedAt: 1,
      orderFinishedAt: 1
    };

    return next();
  }

  function prepareSql(req, res, next)
  {
    var fields = [];
    var conditions = prepareSqlConditions(req.rql.selector);
    var orderBy = [];

    Object.keys(req.rql.fields).forEach(function(key)
    {
      if (PROPERTY_TO_FIELD[key])
      {
        fields.push(PROPERTY_TO_FIELD[key]);
      }
    });

    Object.keys(req.rql.sort).forEach(function(key)
    {
      var field = PROPERTY_TO_FIELD[key];

      if (!field)
      {
        return;
      }

      var asIndex = field.indexOf(' AS ');

      if (asIndex !== -1)
      {
        field = field.substr(0, asIndex);
      }

      orderBy.push(field + ' ' + (req.rql.sort[key] > 0 ? 'ASC' : 'DESC'));
    });

    req.sql = {
      fields: fields.length ? fields.join(', ') : _.values(PROPERTY_TO_FIELD).join(', '),
      conditions: conditions.length ? conditions.join(' AND ') : '1=1',
      orderBy: orderBy.length ? orderBy.join(', ') : 'o.startedAt DESC',
      limit: req.rql.limit,
      offset: req.rql.skip
    };

    next();
  }

  function prepareSqlConditions(selector)
  {
    var conditions = [];

    if (selector.name !== 'and')
    {
      return conditions;
    }

    selector.args.forEach(function(term)
    {
      var condition = TERM_TO_CONDITION[term.name];

      if (!condition)
      {
        return;
      }

      var field = PROPERTY_TO_FIELD[term.args[0]];

      if (!field)
      {
        return;
      }

      if (term.name === 'in')
      {
        if (!Array.isArray(term.args[1]))
        {
          return;
        }

        conditions.push(field + ' IN(' + term.args[1].map(quote).join(', ') + ')');
      }
      else
      {
        conditions.push(field + condition + quote(term.args[1]));
      }
    });

    return conditions;
  }

  function quote(value)
  {
    if (typeof value === 'number' || value === null)
    {
      return value;
    }

    if (typeof value === 'boolean')
    {
      return value ? 1 : 0;
    }

    return '"' + String(value).replace(/"/g, '\\"') + '"';
  }

  function formatDateTime(obj, property)
  {
    if (typeof obj[property] === 'number')
    {
      obj[property] = moment(obj[property]).format('YYYY-MM-DD HH:mm:ss');
    }
  }

  function formatDuration(obj, property)
  {
    if (typeof obj[property] === 'number')
    {
      obj[property] = (obj[property] / 1000).toFixed(3).replace('.', ',');
    }
  }
};
