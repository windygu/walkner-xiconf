// Part of <https://miracle.systems/p/walkner-xiconf> licensed under <CC BY-NC-SA 4.0>

'use strict';

var _ = require('lodash');
var step = require('h5.step');
var coap = require('h5.coap');
var glp2 = require('./glp2');
var gprs = require('./gprs');
var programMowDriver = require('./programMowDriver');
var programSolDriver = require('./programSolDriver');

var FL_LAMP_COUNT = 2;

module.exports = function programAndTestGlp2(app, programmerModule, programmerType, done)
{
  var settings = app[programmerModule.config.settingsId];
  var currentState = programmerModule.currentState;
  var glp2Manager = programmerModule.glp2Manager;

  programmerModule.log('TESTING_STARTED', {program: currentState.program.name});

  if (!settings.supportsFeature('glp2'))
  {
    return done('GLP2:FEATURE_DISABLED');
  }

  var hasFluorescentLampCheck = currentState.program.steps.some(function(step)
  {
    return step.enabled && step.type === 'fn' && step.lampCount > 0;
  });

  if (hasFluorescentLampCheck && !settings.supportsFeature('fl'))
  {
    return done('FL:FEATURE_DISABLED');
  }

  var broker = app.broker.sandbox();
  var startTestAttempts = 0;
  var output = [];
  var prevTxBuffer = new Buffer(0);
  var prevRxNak = false;

  glp2Manager.on('tx', onTx);
  glp2Manager.on('rx', onRx);

  step(
    function resetTesterStep()
    {
      if (programmerModule.cancelled)
      {
        return this.skip();
      }

      programmerModule.log('GLP2:RESETTING_TESTER');

      glp2Manager.reset(1, this.next());
    },
    function handleResetTesterResponseStep(err)
    {
      if (programmerModule.cancelled)
      {
        return this.skip();
      }

      if (err)
      {
        err.code = 'GLP2:RESETTING_TESTER_FAILURE';

        return this.done(done, err);
      }
    },
    function checkTesterReadinessStep()
    {
      if (programmerModule.cancelled)
      {
        return this.skip();
      }

      if (!glp2Manager.isReady())
      {
        return this.skip('GLP2:TESTER_NOT_READY');
      }
    },
    function executeProgramStepsStep()
    {
      if (programmerModule.cancelled)
      {
        return this.skip();
      }

      if (settings.get('glp2AllInOne'))
      {
        return executeAioProgram(currentState.program.steps, this.next());
      }

      var steps = [];

      _.forEach(currentState.program.steps, function(step, i)
      {
        if (step.enabled)
        {
          steps.push(createExecuteProgramStepStep(step, i));
        }
      });

      steps.push(this.next());

      step(steps);
    },
    function finalizeStep(err)
    {
      broker.destroy();

      glp2Manager.removeListener('tx', onTx);
      glp2Manager.removeListener('rx', onRx);

      if (!_.isEmpty(output))
      {
        programmerModule.changeState({output: output.join('\n')});
      }

      setImmediate(done, err);
    }
  );

  function onTx(buffer)
  {
    output.push('[GLP2] TX: ' + glp2.prettifyBuffer(buffer));

    prevTxBuffer = buffer;
  }

  function onRx(buffer)
  {
    output.push('[GLP2] RX: ' + glp2.prettifyBuffer(buffer));

    if (buffer.length === 1
      && buffer[0] === glp2.CHR.NAK
      && prevTxBuffer.length === 3
      && prevTxBuffer[0] === glp2.CHR.STX
      && prevTxBuffer[2] === glp2.CHR.ACK)
    {
      if (prevRxNak)
      {
        output.pop();
        output.pop();
      }

      prevRxNak = true;
    }
    else
    {
      prevRxNak = false;
    }
  }

  function executeAioProgram(steps, done)
  {
    var sharedContext = {
      cleanUp: [],
      finished: false,
      finalizeOnError: finalizeOnError
    };
    var currentStepIndex = -1;
    var completedStepsCount = 0;
    var stepIndexes = [];
    var programSteps = [];

    _.forEach(steps, function(step, stepIndex)
    {
      if (step.enabled)
      {
        stepIndexes.push(stepIndex);

        programSteps.push(createAioProgramStep(step));
      }
    });

    var isFirstVisTest = programSteps[0] instanceof glp2.VisTest;

    step(
      createEmptyActualValuesStep(),
      createSetTestProgramStep(programSteps),
      createStartTestStep(isFirstVisTest),
      function monitorProgressStep(err, res)
      {
        if (programmerModule.cancelled || err)
        {
          return this.skip(err);
        }

        if (res)
        {
          handleProgressResponse(null, res, this.next());
        }
        else if (isFirstVisTest)
        {
          handleInterimProgressResponse(
            new glp2.InterimActualValuesResponse(1, 0, 0, '', 0, '', -1),
            this.next()
          );
        }
        else
        {
          monitorProgress(this.next());
        }
      },
      finalize
    );

    function finalize(err)
    {
      sharedContext.finished = true;

      doCleanUp();

      return setImmediate(done, err);
    }

    function finalizeOnError(err)
    {
      if (err)
      {
        programmerModule.updateStepProgress(completedStepsCount, {
          status: 'failure'
        });

        finalize(err);
      }
    }

    function doCleanUp()
    {
      _.forEach(sharedContext.cleanUp, function(func) { func(); });

      sharedContext.cleanUp = [];
    }

    function monitorProgress(done)
    {
      getActualValues(function(err, res)
      {
        handleProgressResponse(err, res, done);
      });
    }

    function handleProgressResponse(err, res, done)
    {
      if (sharedContext.finished)
      {
        return;
      }

      if (programmerModule.cancelled || err)
      {
        return done(err);
      }

      if (res.type === glp2.ResponseType.INTERIM_ACTUAL_VALUES)
      {
        return handleInterimProgressResponse(res, done);
      }

      if (res.type === glp2.ResponseType.ACTUAL_VALUES)
      {
        return handleFinalProgressResponse(res, done);
      }

      return done('GLP2:UNEXPECTED_RESPONSE');
    }

    function handleInterimProgressResponse(res, done)
    {
      var progressStepIndex = stepIndexes[res.stepNumber - 1];
      var step = steps[progressStepIndex];
      var programStep = programSteps[res.stepNumber - 1];
      var progress = Math.round((res.time / programStep.getTotalTime()) * 100);

      if (progressStepIndex !== currentStepIndex)
      {
        currentStepIndex = progressStepIndex;

        programmerModule.log('TESTING_EXECUTING_STEP', {
          type: step.type,
          index: currentStepIndex
        });

        if (step.type === 'program')
        {
          setUpAioProgramStep(step, currentStepIndex, sharedContext);
        }
        else if (step.type === 'vis')
        {
          setUpAioVisStep(step, currentStepIndex, sharedContext);
        }
        else if (step.type === 'wait')
        {
          setUpAioWaitStep(step, currentStepIndex, sharedContext);
        }
        else
        {
          if (step.type === 'fn')
          {
            setUpAioFnStep(step, currentStepIndex, sharedContext);
          }

          programmerModule.updateStepProgress(currentStepIndex, {
            status: 'active',
            value: res.value1,
            unit: res.unit1,
            progress: progress
          });
        }
      }
      else
      {
        programmerModule.updateStepProgress(progressStepIndex, {
          value: res.value1,
          unit: res.unit1,
          progress: progress
        });

        var remainingTime = programStep.getTotalTime() - res.time;

        if (remainingTime <= 1000)
        {
          app.broker.publish('programmer.glp2.stepNearlyCompleted', {
            stepIndex: progressStepIndex,
            step: programStep,
            remainingTime: remainingTime
          });
        }
      }

      return setImmediate(monitorProgress, done);
    }

    function handleFinalProgressResponse(res, done)
    {
      doCleanUp();

      var programStep = programSteps[completedStepsCount];
      var stepIndex = stepIndexes[completedStepsCount];

      ++completedStepsCount;

      handleActualValuesResponse(programStep, stepIndex, res, function(err)
      {
        if (err)
        {
          return done(err);
        }

        if (completedStepsCount === programSteps.length)
        {
          sharedContext.finished = true;

          return done();
        }

        var nextStep = steps[stepIndexes[completedStepsCount]];

        if (nextStep && (nextStep.type === 'vis' || nextStep.type === 'wait'))
        {
          return setImmediate(
            handleInterimProgressResponse,
            new glp2.InterimActualValuesResponse(completedStepsCount + 1, 0, 0, '', 0, '', -1),
            done
          );
        }

        return setImmediate(monitorProgress, done);
      });
    }
  }

  function createAioProgramStep(step)
  {
    if (step.type === 'pe')
    {
      return glp2.PeTest.fromObject(step);
    }

    if (step.type === 'iso')
    {
      return glp2.IsoTest.fromObject(step);
    }

    if (step.type === 'fn')
    {
      var fctTest = glp2.FctTest.fromObject(step);

      if (step.lampCount > 0)
      {
        fctTest.duration += 1;
      }

      return fctTest;
    }

    if (step.type === 'vis')
    {
      return glp2.VisTest.fromObject(step);
    }

    if (step.type === 'wait')
    {
      return new glp2.VisTest({
        label: 'W8',
        duration: step.kind === 'auto' ? step.duration : 0,
        maxDuration: 86400,
        mode: glp2.VisTest.Mode.NORMAL,
        goInput: 0,
        noGoInput: 0,
        cancelOnFailure: true,
        enabled: true
      });
    }

    if (step.type === 'program')
    {
      return new glp2.FctTest({
        label: step.label,
        setValue: 0,
        upperToleranceRel: 100,
        startTime: 0,
        duration: 120,
        execution: glp2.FctTest.Execution.AUTO,
        range: 0,
        voltage: 230,
        lowerToleranceAbs: 0,
        upperToleranceAbs: 0,
        correction: false,
        mode: glp2.FctTest.Mode.VISUAL_CHECK,
        leaveOn: false,
        uTolerance: 100,
        retries: 0,
        lowerToleranceRel: 100,
        cancelOnFailure: true,
        visMode: glp2.FctTest.VisMode.NORMAL,
        goInput: 0,
        noGoInput: 0,
        enabled: true,
        rsvChannel: glp2.FctTest.RsvChannel.L1_N,
        rsvNumber: 1,
        multi: false,
        trigger: glp2.FctTest.Trigger.START_TIME
      });
    }
  }

  function setUpAioProgramStep(step, stepIndex, aioContext)
  {
    programmerModule.updateStepProgress(stepIndex, {
      status: 'active',
      progress: 0,
      value: -1
    });

    var programmingFinished = programmerType === null;
    var doProgrammingTimer = programmerType === null
      ? null
      : setTimeout(doProgramming, settings.get('glp2ProgrammingDelay') || 0);
    var cancelMowProgrammingSub = null;
    var cancelProgrammingSub = broker.subscribe(
      'programmer.cancelled',
      function()
      {
        programmingFinished = true;

        aioContext.finalizeOnError('CANCELLED');
      }
    );
    var waitForContinue = glp2Manager.getSoftwareVersion() < 4.6;

    if (programmerType === null)
    {
      programmerModule.log('TESTING_SKIPPING_PROGRAMMING');

      if (waitForContinue)
      {
        programmerModule.changeState({waitingForContinue: 'programmed'});
      }

      glp2Manager.ackVisTest(true, aioContext.finalizeOnError);
    }

    aioContext.cleanUp.push(function()
    {
      if (waitForContinue)
      {
        programmerModule.changeState({waitingForContinue: null});
      }

      if (doProgrammingTimer)
      {
        clearTimeout(doProgrammingTimer);
        doProgrammingTimer = null;
      }

      cancelProgrammingSub.cancel();

      if (!programmingFinished && !programmerModule.cancelled)
      {
        programmingFinished = true;
        aioContext.finished = true;
        programmerModule.cancelled = true;

        app.broker.publish('programmer.cancelled');
      }
    });

    function doProgramming()
    {
      if (programmerType === 'gprs')
      {
        return gprs.program(app, programmerModule, onProgrammingProgress, onProgrammingFinished);
      }

      if (programmerType === 'sol')
      {
        return programSolDriver(app, programmerModule, null, onProgrammingProgress, onProgrammingFinished);
      }

      if (programmerType === 'mow')
      {
        cancelMowProgrammingSub = programMowDriver(app, programmerModule, onProgrammingProgress, onProgrammingFinished);
      }
    }

    function onProgrammingFinished(err)
    {
      if (cancelMowProgrammingSub)
      {
        cancelMowProgrammingSub.cancel();
        cancelMowProgrammingSub = null;
      }

      if (programmingFinished)
      {
        return;
      }

      programmingFinished = true;

      if (_.isString(currentState.output) && currentState.output.length)
      {
        output.push(currentState.output.trim());
      }

      if (err)
      {
        aioContext.finalizeOnError(err);
      }
      else
      {
        if (waitForContinue)
        {
          programmerModule.changeState({waitingForContinue: 'programmed'});
        }

        glp2Manager.ackVisTest(true, aioContext.finalizeOnError);
      }
    }

    function onProgrammingProgress(progress)
    {
      programmerModule.updateStepProgress(stepIndex, {progress: progress});
    }
  }

  function setUpAioVisStep(step, stepIndex, aioContext)
  {
    var cancelSub = broker.subscribe('programmer.cancelled', aioContext.finalizeOnError.bind(null, 'CANCELLED'));
    var waitingSub = null;
    var waitingTimer = null;
    var progressTimer = null;

    aioContext.cleanUp.push(function()
    {
      if (cancelSub)
      {
        cancelSub.cancel();
        cancelSub = null;
      }

      if (waitingSub)
      {
        waitingSub.cancel();
        waitingSub = null;
      }

      if (waitingTimer)
      {
        clearTimeout(waitingTimer);
        waitingTimer = null;
      }

      if (progressTimer)
      {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    });

    programmerModule.updateStepProgress(stepIndex, {
      status: 'active',
      progress: 0,
      value: -1
    });

    var totalTime = step.maxDuration * 1000;
    var startTime = Date.now();

    progressTimer = setInterval(function()
    {
      programmerModule.updateStepProgress(stepIndex, {
        progress: (Date.now() - startTime) * 100 / totalTime
      });
    }, 250);

    waitingTimer = setTimeout(function()
    {
      programmerModule.changeState({waitingForContinue: 'vis'});

      waitingSub = broker.subscribe('programmer.stateChanged', function(changes)
      {
        if (changes.waitingForContinue === null)
        {
          glp2Manager.ackVisTest(true, aioContext.finalizeOnError);
        }
      });

      aioContext.cleanUp.push(function()
      {
        if (currentState.waitingForContinue !== null)
        {
          programmerModule.changeState({waitingForContinue: null});
        }
      });
    }, step.duration * 1000);
  }

  function setUpAioWaitStep(step, stepIndex, aioContext)
  {
    var cancelSub = broker.subscribe('programmer.cancelled', aioContext.finalizeOnError.bind(null, 'CANCELLED'));
    var waitingSub = null;
    var successTimer = null;
    var progressTimer = null;

    aioContext.cleanUp.push(function()
    {
      if (cancelSub)
      {
        cancelSub.cancel();
        cancelSub = null;
      }

      if (waitingSub)
      {
        waitingSub.cancel();
        waitingSub = null;
      }

      if (successTimer)
      {
        clearTimeout(successTimer);
        successTimer = null;
      }

      if (progressTimer)
      {
        clearInterval(progressTimer);
        progressTimer = null;
      }
    });

    if (step.kind === 'auto')
    {
      programmerModule.updateStepProgress(stepIndex, {
        status: 'active',
        progress: 0,
        value: -1
      });

      var totalTime = step.duration * 1000;
      var startTime = Date.now();

      successTimer = setTimeout(
        glp2Manager.ackVisTest.bind(glp2Manager, true, aioContext.finalizeOnError),
        totalTime + 1
      );
      progressTimer = setInterval(function()
      {
        programmerModule.updateStepProgress(stepIndex, {
          progress: (Date.now() - startTime) * 100 / totalTime
        });
      }, 250);

      return;
    }

    programmerModule.updateStepProgress(stepIndex, {
      status: 'active',
      progress: 50,
      value: -1
    });

    programmerModule.changeState({waitingForContinue: 'test'});

    waitingSub = broker.subscribe('programmer.stateChanged', function(changes)
    {
      if (changes.waitingForContinue === null)
      {
        glp2Manager.ackVisTest(true, aioContext.finalizeOnError);
      }
    });

    aioContext.cleanUp.push(function()
    {
      if (currentState.waitingForContinue !== null)
      {
        programmerModule.changeState({waitingForContinue: null});
      }
    });
  }

  function setUpAioFnStep(step, stepIndex, aioContext)
  {
    if (!step.lampCount)
    {
      return;
    }

    var flDurations = {};
    var cancelFlMonitor = monitorFluorescentLamps(step.lampCount, flDurations);
    var stepNearlyCompletedSub = app.broker.subscribe('programmer.glp2.stepNearlyCompleted')
      .setLimit(1)
      .on('message', function()
      {
        if (!checkFlDurations(step.lampCount, step.lampDuration, flDurations))
        {
          aioContext.finalizeOnError('FL:LIGHTING_TIME_TOO_SHORT');
        }
      });

    aioContext.cleanUp.push(function()
    {
      cancelFlMonitor();
      stepNearlyCompletedSub.cancel();
    });
  }

  function createExecuteProgramStepStep(step, stepIndex)
  {
    if (step.type === 'wait')
    {
      return createExecuteWaitStepStep(step, stepIndex);
    }

    if (step.type === 'pe')
    {
      return createExecutePeStepStep(step, stepIndex);
    }

    if (step.type === 'iso')
    {
      return createExecuteIsoStepStep(step, stepIndex);
    }

    if (step.type === 'program')
    {
      return createExecuteProgrammingStepStep(step, stepIndex);
    }

    if (step.type === 'fn')
    {
      return createExecuteFnStepStep(step, stepIndex);
    }

    if (step.type === 'vis')
    {
      return createExecuteVisStepStep(step, stepIndex);
    }

    return function() {};
  }

  function createFinalizeProgramStepStep(stepIndex, done)
  {
    return function finalizeProgramStepStep(err)
    {
      if (this.successTimer)
      {
        clearTimeout(this.successTimer);
        this.successTimer = null;
      }

      if (this.cancelSub)
      {
        this.cancelSub.cancel();
        this.cancelSub = null;
      }

      if (programmerModule.cancelled)
      {
        err = 'CANCELLED';
      }

      if (err)
      {
        if (stepIndex >= 0)
        {
          programmerModule.updateStepProgress(stepIndex, {
            status: 'failure'
          });
        }

        return done(err);
      }

      if (stepIndex >= 0)
      {
        programmerModule.updateStepProgress(stepIndex, {
          status: 'success',
          progress: 100
        });
      }

      var finalizeResponse = this.finalizeResponse;

      if (finalizeResponse)
      {
        this.finalizeResponse = null;
      }

      setImmediate(done, null, finalizeResponse);
    };
  }

  function createExecuteWaitStepStep(programStep, stepIndex, waitingForContinue)
  {
    return function executeWaitStepStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      if (stepIndex >= 0)
      {
        programmerModule.log('TESTING_EXECUTING_STEP', {
          type: programStep.type,
          index: stepIndex
        });

        programmerModule.updateStepProgress(stepIndex, {
          status: 'active',
          progress: 0,
          value: -1
        });
      }

      var nextProgramStep = this.next();
      var finalizeResponse = null;

      step(
        createEmptyActualValuesStep(),
        function()
        {
          var nextStep = this.next();
          var successTimer = null;
          var progressTimer = null;
          var waitingSub;
          var cancelSub;

          if (programStep.kind === 'auto')
          {
            var totalTime = programStep.duration * 1000;
            var startTime = Date.now();

            this.successTimer = successTimer = setTimeout(nextStep, totalTime);
            this.progressTimer = progressTimer = setInterval(function()
            {
              programmerModule.updateStepProgress(stepIndex, {
                progress: (Date.now() - startTime) * 100 / totalTime
              });
            }, 250);
          }
          else
          {
            if (stepIndex >= 0)
            {
              programmerModule.updateStepProgress(stepIndex, {
                progress: 50
              });
            }

            programmerModule.changeState({waitingForContinue: waitingForContinue || 'test'});

            this.waitingSub = waitingSub = broker.subscribe('programmer.stateChanged', function(changes)
            {
              if (changes.waitingForContinue === null)
              {
                waitingSub.cancel();
                waitingSub = null;

                cancelSub.cancel();
                cancelSub = null;

                setImmediate(nextStep);
              }
            });

            this.cancelMonitor = getActualValues(function(err, res)
            {
              if (err)
              {
                return nextStep(err);
              }

              finalizeResponse = res;

              programmerModule.changeState({waitingForContinue: null});
            });
          }

          cancelSub = this.cancelSub = broker.subscribe('programmer.cancelled', function()
          {
            if (successTimer !== null)
            {
              clearTimeout(successTimer);
              clearInterval(progressTimer);
            }

            nextStep();
          });
        },
        function(err)
        {
          if (this.cancelMonitor)
          {
            this.cancelMonitor();
            this.cancelMonitor = null;
          }

          if (this.progressTimer)
          {
            clearTimeout(this.progressTimer);
            this.progressTimer = null;
          }

          if (this.waitingSub)
          {
            this.waitingSub.cancel();
            this.waitingSub = null;
          }

          if (err)
          {
            return this.skip(err);
          }

          this.finalizeResponse = finalizeResponse;
        },
        createFinalizeProgramStepStep(stepIndex, nextProgramStep)
      );
    };
  }

  function createExecutePeStepStep(programStep, stepIndex)
  {
    return function executePeStepStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      programmerModule.log('TESTING_EXECUTING_STEP', {
        type: programStep.type,
        index: stepIndex
      });

      programmerModule.updateStepProgress(stepIndex, {
        status: 'active',
        progress: 0
      });

      executeTestStep(glp2.PeTest.fromObject(programStep), stepIndex, this.next());
    };
  }

  function createExecuteIsoStepStep(programStep, stepIndex)
  {
    return function executeIsoStepStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      programmerModule.log('TESTING_EXECUTING_STEP', {
        type: programStep.type,
        index: stepIndex
      });

      programmerModule.updateStepProgress(stepIndex, {
        status: 'active',
        progress: 0
      });

      executeTestStep(glp2.IsoTest.fromObject(programStep), stepIndex, this.next());
    };
  }

  function createExecuteProgrammingStepStep(programStep, stepIndex)
  {
    function onProgrammingProgress(progress)
    {
      programmerModule.updateStepProgress(stepIndex, {progress: progress});
    }

    return function executeProgrammingStepStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      if (programmerType === null)
      {
        programmerModule.log('TESTING_SKIPPING_PROGRAMMING');

        programmerModule.updateStepProgress(stepIndex, {
          status: 'success',
          progress: 100
        });

        return setImmediate(this.next());
      }

      programmerModule.log('TESTING_EXECUTING_STEP', {
        type: programStep.type,
        index: stepIndex
      });

      programmerModule.updateStepProgress(stepIndex, {
        status: 'active',
        progress: 0,
        value: -1
      });

      var reset = true;
      var programmingStep = new glp2.FctTest({
        label: programStep.label,
        setValue: 0,
        upperToleranceRel: 100,
        startTime: 60,
        duration: 120,
        execution: glp2.FctTest.Execution.AUTO,
        range: 0,
        voltage: 230,
        lowerToleranceAbs: 0,
        upperToleranceAbs: 0,
        correction: false,
        mode: glp2.FctTest.Mode.VISUAL_CHECK,
        leaveOn: false,
        uTolerance: 100,
        retries: 0,
        lowerToleranceRel: 100,
        cancelOnFailure: true,
        visMode: glp2.FctTest.VisMode.NORMAL,
        goInput: 0,
        noGoInput: 0,
        enabled: true,
        rsvChannel: glp2.FctTest.RsvChannel.L1_N,
        rsvNumber: 1,
        multi: false,
        trigger: glp2.FctTest.Trigger.START_TIME
      });

      step(
        createEmptyActualValuesStep(),
        createSetTestProgramStep(programmingStep),
        createStartTestStep(),
        function delayProgrammingStep(err)
        {
          if (programmerModule.cancelled || err)
          {
            return this.skip(err);
          }

          var nextStep = this.next();
          var nextStepTimer = setTimeout(nextStep, settings.get('glp2ProgrammingDelay') || 0);

          this.cancelSub = broker.subscribe('programmer.cancelled', function()
          {
            clearTimeout(nextStepTimer);
            nextStep();
          });
        },
        function programStep()
        {
          if (programmerModule.cancelled)
          {
            return this.skip();
          }

          if (this.cancelSub)
          {
            this.cancelSub.cancel();
            this.cancelSub = null;
          }

          var nextStep = this.next();

          if (programmerType === null)
          {
            return setImmediate(nextStep, 'GLP2:PROGRAM_NOT_RECOGNIZED');
          }

          this.outputSub = broker.subscribe('programmer.stateChanged', function(changes)
          {
            if (changes.output === undefined)
            {
              return;
            }

            if (_.isString(changes.output) && changes.output.length)
            {
              output.push(changes.output.trim());
            }

            // Reset only after GPRS programming, because it also has a verification step.
            if (programmerType !== 'gprs')
            {
              return;
            }

            reset = false;

            glp2Manager.reset(function(err)
            {
              if (err)
              {
                programmerModule.error("[GLP2] Failed to reset after programming: %s", err.message);
              }
            });
          });

          if (programmerType === 'gprs')
          {
            return gprs.program(app, programmerModule, onProgrammingProgress, nextStep);
          }

          if (programmerType === 'sol')
          {
            return programSolDriver(app, programmerModule, null, onProgrammingProgress, nextStep);
          }

          if (programmerType === 'mow')
          {
            this.cancelSub = programMowDriver(app, programmerModule, onProgrammingProgress, nextStep);
          }
        },
        function cleaUpProgramStep(err)
        {
          if (this.outputSub)
          {
            this.outputSub.cancel();
            this.outputSub = null;
          }

          if (programmerModule.cancelled || err)
          {
            return this.skip(err);
          }

          if (reset)
          {
            glp2Manager.reset(this.next());
          }
        },
        createFinalizeProgramStepStep(stepIndex, this.next())
      );
    };
  }

  function createExecuteFnStepStep(programStep, stepIndex)
  {
    return function executeFnStepStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      programmerModule.log('TESTING_EXECUTING_STEP', {
        type: programStep.type,
        index: stepIndex
      });

      programmerModule.updateStepProgress(stepIndex, {
        status: 'active',
        progress: 0
      });

      step(
        function executeTestStepStep()
        {
          var fctTest = glp2.FctTest.fromObject(programStep);
          var nextStep = _.once(this.next());

          if (programStep.lampCount > 0)
          {
            fctTest.duration += 1;

            var lampCount = programStep.lampCount;
            var lampDuration = programStep.lampDuration;
            var flDurations = {};

            this.cancelFlMonitor = monitorFluorescentLamps(lampCount, flDurations);

            this.stepNearlyCompletedSub = app.broker.subscribe('programmer.glp2.stepNearlyCompleted')
              .setLimit(1)
              .on('message', function()
              {
                if (!checkFlDurations(lampCount, lampDuration, flDurations))
                {
                  nextStep('FL:LIGHTING_TIME_TOO_SHORT');
                }
              });
          }

          executeTestStep(fctTest, stepIndex, nextStep);
        },
        function checkFlResultsStep(err)
        {
          if (this.stepNearlyCompletedSub)
          {
            this.stepNearlyCompletedSub.cancel();
            this.stepNearlyCompletedSub = null;
          }

          if (this.cancelFlMonitor)
          {
            this.cancelFlMonitor();
            this.cancelFlMonitor = null;
          }

          if (err)
          {
            return this.skip(err);
          }
        },
        this.next()
      );
    };
  }

  function createExecuteVisStepStep(programStep, stepIndex)
  {
    return function executeVisStepStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      programmerModule.log('TESTING_EXECUTING_STEP', {
        type: programStep.type,
        index: stepIndex
      });

      programmerModule.updateStepProgress(stepIndex, {
        status: 'active',
        progress: 0,
        value: -1
      });

      step(
        createEmptyActualValuesStep(),
        createSetTestProgramStep(glp2.VisTest.fromObject(programStep)),
        createStartTestStep(true),
        function executeVisStep()
        {
          var nextStep = this.next();
          var ackTimer = null;
          var progressTimer = null;
          var waitingSub = null;
          var ackStartTime = programStep.duration * 1000;
          var totalTime = 0;
          var startTime = Date.now();

          if (programStep.maxDuration)
          {
            totalTime = programStep.maxDuration * 1000;
          }
          else if (programStep.duration)
          {
            totalTime = programStep.duration * 2 * 1000;
          }

          this.ackTimer = ackTimer = setTimeout(function()
          {
            programmerModule.changeState({
              waitingForContinue: 'vis'
            });
          }, ackStartTime);

          this.progressTimer = progressTimer = setInterval(function()
          {
            programmerModule.updateStepProgress(stepIndex, {
              progress: (Date.now() - startTime) * 100 / totalTime
            });
          }, 250);

          this.waitingSub = waitingSub = broker.subscribe('programmer.stateChanged', function(changes)
          {
            if (changes.waitingForContinue !== null)
            {
              return;
            }

            clearTimeout(ackTimer);
            clearInterval(progressTimer);
            waitingSub.cancel();

            glp2Manager.ackVisTest(true, function(err)
            {
              if (err)
              {
                nextStep(err);
              }
            });
          });

          this.cancelMonitor = getActualValues(function(err, res)
          {
            if (programmerModule.cancelled || err)
            {
              return nextStep(err);
            }

            clearTimeout(ackTimer);
            clearInterval(progressTimer);
            waitingSub.cancel();

            programmerModule.changeState({waitingForContinue: null});

            handleActualValuesResponse(programStep, stepIndex, res, nextStep);
          });

          this.cancelSub = broker.subscribe('programmer.cancelled', nextStep);
        },
        function cleanUpVisStep(err)
        {
          if (this.cancelMonitor)
          {
            this.cancelMonitor();
            this.cancelMonitor = null;
          }

          if (this.ackTimer)
          {
            clearTimeout(this.ackTimer);
            this.ackTimer = null;
          }

          if (this.progressTimer)
          {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
          }

          if (this.waitingSub)
          {
            this.waitingSub.cancel();
            this.waitingSub = null;
          }

          if (err)
          {
            return this.skip(err);
          }
        },
        createFinalizeProgramStepStep(stepIndex, this.next())
      );
    };
  }

  function executeTestStep(programStep, stepIndex, done)
  {
    step(
      createEmptyActualValuesStep(),
      createSetTestProgramStep(programStep),
      createStartTestStep(),
      createMonitorActualValuesStep(programStep, stepIndex),
      createFinalizeProgramStepStep(stepIndex, done)
    );
  }

  function createSetTestProgramStep(programStep)
  {
    return function setTestProgramStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      glp2Manager.setTestProgram(currentState.program.name, programStep, this.next());
    };
  }

  function createStartTestStep(autostart)
  {
    return function startTestStep(err)
    {
      ++startTestAttempts;

      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      if (autostart || startTestAttempts > 1)
      {
        return glp2Manager.startTest(this.next());
      }

      step(
        createExecuteWaitStepStep({kind: 'manual'}, -1, 'glp2'),
        this.next()
      );
    };
  }

  function createEmptyActualValuesStep()
  {
    return function emptyActualValuesStep(err)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      emptyActualValues(this.next());
    };
  }

  function createMonitorActualValuesStep(programStep, stepIndex)
  {
    return function monitorActualValuesStep(err, res)
    {
      if (programmerModule.cancelled || err)
      {
        return this.skip(err);
      }

      if (res)
      {
        handleGetActualValuesResponse(programStep, stepIndex, res, this.next());
      }
      else
      {
        monitorActualValues(programStep, stepIndex, this.next());
      }
    };
  }

  function emptyActualValues(done)
  {
    glp2Manager.getActualValues(function(err, res)
    {
      if (programmerModule.cancelled || err)
      {
        return done(err);
      }

      if (res)
      {
        return setImmediate(emptyActualValues, done);
      }

      return setImmediate(done);
    });
  }

  function monitorActualValues(programStep, stepIndex, done)
  {
    getActualValues(function(err, res)
    {
      if (err)
      {
        return done(err);
      }

      return handleGetActualValuesResponse(programStep, stepIndex, res, done);
    });
  }

  function getActualValues(done)
  {
    var cancelled = false;

    glp2Manager.getActualValues(function(err, res)
    {
      if (cancelled)
      {
        return;
      }

      if (programmerModule.cancelled || err)
      {
        return done(err);
      }

      if (!res)
      {
        return setImmediate(getActualValues, done);
      }

      return setImmediate(done, null, res);
    });

    return function() { cancelled = true; };
  }

  function handleGetActualValuesResponse(programStep, stepIndex, res, done)
  {
    if (programmerModule.cancelled)
    {
      return done();
    }

    if (res.type === glp2.ResponseType.INTERIM_ACTUAL_VALUES)
    {
      return handleInterimActualValuesResponse(programStep, stepIndex, res, done);
    }

    if (res.type === glp2.ResponseType.ACTUAL_VALUES)
    {
      return handleActualValuesResponse(programStep, stepIndex, res, done);
    }

    return done('GLP2:UNEXPECTED_RESPONSE');
  }

  function handleInterimActualValuesResponse(programSteps, stepIndexes, res, done)
  {
    var programStep;
    var stepIndex;

    if (_.isObject(stepIndexes))
    {
      programStep = programSteps[res.stepNumber - 1];
      stepIndex = stepIndexes[res.stepNumber - 1];
    }
    else
    {
      programStep = programSteps;
      stepIndex = stepIndexes;
    }

    programmerModule.updateStepProgress(stepIndex, {
      value: res.value1,
      unit: res.unit1,
      progress: Math.round((res.time / programStep.getTotalTime()) * 100)
    });

    var remainingTime = programStep.getTotalTime() - res.time;

    if (remainingTime <= 1000)
    {
      app.broker.publish('programmer.glp2.stepNearlyCompleted', {
        stepIndex: stepIndex,
        step: programStep,
        remainingTime: remainingTime
      });
    }

    setImmediate(monitorActualValues, programSteps, stepIndexes, done);
  }

  function handleActualValuesResponse(programSteps, stepIndexes, res, done)
  {
    var stepNumber = res.steps.length ? (res.steps[0].stepNumber - 1) : -1;
    var stepIndex = _.isObject(stepIndexes) ? stepIndexes[stepNumber] : stepIndexes;

    if (programmerModule.cancelled)
    {
      programmerModule.updateStepProgress(stepIndex, {
        status: 'failure'
      });

      return setImmediate(done, 'GLP2:FAULT:' + glp2.FaultStatus.CANCELLED);
    }

    if (res.faultStatus)
    {
      programmerModule.updateStepProgress(stepIndex, {
        status: 'failure'
      });

      return setImmediate(done, 'GLP2:FAULT:' + res.faultStatus);
    }

    var testResult = res.steps[0];

    if (!testResult)
    {
      // No test results and completed? Operator cancelled the test using the tester's panel.
      if (res.completed)
      {
        programmerModule.updateStepProgress(stepIndex, {
          status: 'failure'
        });

        return setImmediate(done, 'GLP2:FAULT:' + glp2.FaultStatus.CANCELLED);
      }

      return setImmediate(done);
    }

    if (testResult.evaluation)
    {
      programmerModule.updateStepProgress(stepIndex, {
        status: 'success',
        progress: 100
      });

      return setImmediate(done);
    }

    programmerModule.updateStepProgress(stepIndex, {
      status: 'failure'
    });

    if (testResult.setValue === undefined)
    {
      return setImmediate(done, 'GLP2:TEST_STEP_FAILURE');
    }

    programmerModule.log('GLP2:TEST_STEP_FAILURE', {
      setValue: testResult.setValue,
      actualValue: testResult.actualValue,
      setValue2: testResult.setValue2,
      actualValue2: testResult.actualValue2
    });

    var testStepFailureErr = new Error(
      "Expected set value 1: `" + testResult.setValue
        + "`, got actual value 1: `" + testResult.actualValue + "`."
        + " Expected set value 2: `" + testResult.setValue2
        + "`, got actual value 2: `" + testResult.actualValue2 + "`."
    );
    testStepFailureErr.code = 'GLP2:TEST_STEP_FAILURE';

    return setImmediate(done, testStepFailureErr);
  }

  function monitorFluorescentLamps(lampCount, flDurations)
  {
    programmerModule.log('FL:MONITORING', {
      count: lampCount
    });

    var coapClient = new coap.Client({
      socket4: false,
      socket6: true,
      ackTimeout: 100,
      ackRandomFactor: 1,
      maxRetransmit: 1
    });
    var resources = new Array(FL_LAMP_COUNT);
    var cancelled = false;
    var onAt = {};

    for (var i = 0; i < FL_LAMP_COUNT; ++i)
    {
      resources[i] = settings.get('flResource' + (i + 1));
      flDurations[i] = 0;
      onAt[i] = -1;
    }

    setImmediate(monitorState);

    return function() { cancelled = true; };

    function monitorState()
    {
      if (cancelled)
      {
        coapClient.destroy();

        return;
      }

      step(
        function()
        {
          this.startedAt = Date.now();

          for (var i = 0; i < FL_LAMP_COUNT; ++i)
          {
            if (_.isEmpty(resources[i]))
            {
              setImmediate(this.group(), null, null);
            }
            else
            {
              request(resources[i], this.group());
            }
          }
        },
        function(err, states)
        {
          if (cancelled)
          {
            return;
          }

          if (!Array.isArray(states))
          {
            states = [];
          }

          var now = Date.now();

          for (var i = 0; i < FL_LAMP_COUNT; ++i)
          {
            var state = states[i];
            var lastOnAt = onAt[i];

            if (state === null || (state === false && lastOnAt === -1))
            {
              continue;
            }

            if (lastOnAt === -1)
            {
              onAt[i] = now;

              continue;
            }

            var onDuration = now - lastOnAt;

            if (onDuration > flDurations[i])
            {
              flDurations[i] = onDuration;
            }

            if (!state)
            {
              onAt[i] = -1;
            }
          }

          setTimeout(monitorState, Math.max(33 - (now - this.startedAt), 1));
        }
      );
    }

    function request(uri, done)
    {
      if (cancelled)
      {
        return done(null, null);
      }

      var req = coapClient.get(uri, {type: 'NON'});
      var complete = _.once(done);

      req.on('timeout', complete.bind(null, null, null));
      req.on('error', complete.bind(null, null, null));
      req.on('response', function(res)
      {
        var state = null;

        if (res.getCode() === coap.Message.Code.CONTENT)
        {
          var payload = res.getPayload().toString();

          if (payload.indexOf('ON') !== -1)
          {
            state = true;
          }
          else if (payload.indexOf('OFF') !== -1)
          {
            state = false;
          }
        }

        complete(null, state);
      });
    }
  }

  function checkFlDurations(lampCount, requiredDuration, flDurations)
  {
    if (!lampCount || !requiredDuration)
    {
      return true;
    }

    var validCount = 0;

    for (var i = 0; i < FL_LAMP_COUNT; ++i)
    {
      var actualDuration = flDurations[i];

      if ((actualDuration / 1000) >= requiredDuration)
      {
        ++validCount;
      }

      programmerModule.log('FL:LIGHTING_TIME', {
        no: i + 1,
        duration: actualDuration
      });
    }

    return validCount === lampCount;
  }
};
