/**
 * Module dependencies
 */

var util = require('util');
var _ = require('lodash');
var program = require('commander');
var chalk = require('chalk');
var yargs = require('yargs');
var Machine = require('machine');
var rttc = require('rttc');



/**
 * asScript()
 *
 * (See README.md for more information.)
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * @param  {Dictionary|Machine} optsOrMachineDef
 *         @property {Dictionary?} machine
 *         @property {Array?} args
 *         @property {Array?} envVarNamespace
 *         @property {SailsApp?} sails
 *
 * @return {Machine}
 *         A live machine instance, but warped to accept CLI args/opts & env vars.
 *         Also granted other special abilities.
 */
module.exports = function runMachineAsScript(optsOrMachineDef){

  optsOrMachineDef = optsOrMachineDef||{};

  // Use either `opts` or `opts.machine` as the machine definition
  // If `opts.machine` is truthy, we'll use that as the machine definition.
  // Otherwise, we'll understand the entire `opts` dictionary to be the machine
  // definition.
  var machineDef;
  var opts;
  var MISC_OPTIONS = ['args', 'envVarNamespace', 'sails'];
  if (!optsOrMachineDef.machine) {
    machineDef = optsOrMachineDef;
    opts = _.pick(optsOrMachineDef, MISC_OPTIONS);
  }
  else {
    machineDef = optsOrMachineDef.machine;
    opts = _.pick(optsOrMachineDef, MISC_OPTIONS);
  }

  if (!_.isObject(machineDef)) {
    throw new Error('Consistency violation: Machine definition must be provided as a dictionary.');
  }

  // Set up namespace for environment variables.
  var envVarNamespace = '___';
  if (_.isString(opts.envVarNamespace)) {
    envVarNamespace = opts.envVarNamespace;
  }

  // `Machine.build()` tolerates:
  //   • machine definitions
  //   • already-instantiated ("wet") machine instances (just passes them through)
  //   • naked functions (builds them into an anonymous machine automatically.  For convenience and quick prototyping)

  // But since we're modifying the machine definition here...
  // (TODO: consider moving this into machine runner-- but need to do that _carefully_-- there's complexities in there)
  // we need to duck-type the provided machine to determine whether or not it is an already-instantiated machine or not.
  // If it is, use as-is. Otherwise, use the definition to build a new machine.
  // (checks new `isWetMachine` property, but also the function name for backwards compatibility)
  var wetMachine;
  if ( machineDef.isWetMachine || machineDef.name==='_callableMachineWrapper') {
    wetMachine = machineDef;
  }
  else {
    wetMachine = Machine.build(_.extend({
      identity: machineDef.identity || (machineDef.friendlyName ? _.kebabCase(machineDef.friendlyName) : 'anonymous-machine-as-script'),
      inputs: {},
      exits: {
        success: {
          description: 'Done.'
        },
        error: {
          description: 'Unexpected error occurred.'
        }
      },
      fn: function (inputs, exits){
        exits.error(new Error('Not implemented yet! (This is a default `fn` injected by `machine-as-script`.)'));
      }
    },machineDef));
  }


  // Finally, before moving on, we check the `habitat` and potentially provide
  // access to `env.sails`.
  var sailsApp;
  if (wetMachine.habitat === 'request') {
    throw new Error('The target machine defintion declares a dependency on the `request` habitat, which cannot be provided via the command-line interface.  This machine cannot be run using machine-as-script.');
  }
  else if (wetMachine.habitat === 'sails') {

    // If the machine depends on the Sails habitat, then we'll attempt to use the provided version of `sails`.
    if (opts.sails) {
      if (!_.isObject(opts.sails) || opts.sails.constructor.name !== 'Sails') {
        throw new Error('The supposed Sails app instance provided as `sails` seems a little sketchy.  Make sure you are doing `sails: require(\'sails\')`.');
      }
      // Down below, we'll attempt to load (but not lift) the Sails app in the current working directory.
      // If it works, then we'll run the script, providing it with `env.sails`.  After that, regardless of
      // how the script exits, we'll call `sails.lower()` to clean up.
      sailsApp = opts.sails;
    }
    // If no `sails` was provided to machine-as-script, then we'll throw an error.
    else {
      throw new Error('The target machine defintion declares a dependency on the `sails` habitat, but no `sails` app instance was provided as a top-level option to machine-as-script.  Make sure this script module is doing: `sails: require(\'sails\')`');
    }
  }



  // ======================================================================
  // Now we'll put together the configuration for our wet machine instance.
  // (using CLI opts, serial CLI args, and/or env vars)
  // ======================================================================

  // Configure CLI usage helptext and set up commander
  program.usage('[options]');

  // Keep track of shortcuts used (e.g. can't have a "-p" option mean two different things at once)
  var shortcutsSoFar = [];

  // Loop over each input and set up command line opts for usage docs generated by commander.
  _.each(wetMachine.inputs, function (inputDef, inputName) {

    // Handle `--` flags
    var opt = '--'+inputName;

    // Handle `-` shortcuts
    var optShortcut = (function (){
      var _shortcut = '-'+inputName[0];
      // If shortcut flag already exists using the same letter, don't provide a shortcut for this option.
      if (_.contains(shortcutsSoFar, _shortcut)) return;
      // Otherwise, keep track of the shortcut so we don't inadvertently use it again.
      shortcutsSoFar.push(_shortcut);
      return _shortcut;
    })();
    var optDescription = (function determineOptDescription(){
      var _optDescription = inputDef.description || inputDef.friendlyName || '';
      return (_optDescription[0]||'').toLowerCase() + _optDescription.slice(1);
    })();

    // Call out to commander and apply usage
    var optUsage = (function (){
      if (optShortcut){
        return util.format('%s, %s', optShortcut, opt);
      }
      return util.format('%s', opt);
    })();
    if (optDescription) {
      program.option(optUsage, optDescription);
    }
    else {
      program.option(optUsage);
    }

  });
  program.parse(process.argv);


  // Notice we DON'T tolerate unknown options
  // If we wnated to, we'd have to have something like the following:
  // .unknownOption = function NOOP(){};


  // Build inputs from CLI options and args
  var inputConfiguration = {};

  // Supply CLI options
  _.extend(inputConfiguration, yargs.argv);
  delete inputConfiguration._;
  delete inputConfiguration.$0;

  // Supply environment variables
  _.each(wetMachine.inputs, function (inputDef, inputName){
    var envVarData = process.env[envVarNamespace + inputName];
    if (_.isUndefined(envVarData)) {
      return;
    }

    // If environment variable exists, we'll grab its value and
    // supply it as configuration for this input.
    inputConfiguration[inputName] = envVarData;
  });

  // Include a special `args` input for convenience--
  // but note that this is an experimental feature that could change.
  if (_.isArray(yargs.argv._)) {
    inputConfiguration.args = yargs.argv._;
  }

  // Supply argv CLI arguments using special `args` notation
  if (_.isArray(opts.args)) {
    _.each(opts.args, function (inputName, i){
      inputConfiguration[inputName] = yargs.argv._[i];
    });
  }

  // Finally, loop through each of the input configurations and run `rttc.parseHuman()`.
  inputConfiguration = _.reduce(inputConfiguration, function (memo, val, inputName){

    // Skip special `args` input (unless there's actually an input named `args`.)
    var inputDef = wetMachine.inputs[inputName];
    if (!inputDef && inputName === 'args') {
      return memo;
    }
    if (!inputDef) {
      throw new Error('Unexpected error: received configuration for unknown input ('+inputName+')');
    }
    // Before using `rttc.parseHuman()`, ensure the value is a string
    // (yargs parses some things as numbers)
    val = val+'';
    memo[inputName] = rttc.parseHuman(val, rttc.infer(inputDef.example), true);
    return memo;
  }, {});

  // Set input values from CLI args/opts
  var liveMachine = wetMachine(inputConfiguration);


  // Now build up a default handler callback for each exit.
  // (Note that these can be overridden though!)
  var callbacks = {};
  // We use a local variable (`alreadyExited`) as a spinlock.
  var alreadyExited;
  _.each(_.keys(wetMachine.exits), function builtExitCallback(exitCodeName){

    // Build a callback for this exit that sends the appropriate response.
    callbacks[exitCodeName] = function respondApropos(output){
      // This spinlock protects against the machine calling more than one
      // exit, or the same exit twice.
      if (alreadyExited) { return; }
      alreadyExited = true;

      if (exitCodeName === 'error') {
        console.error(chalk.red('Unexpected error occurred:\n'), output);
        console.error(output.stack ? chalk.gray(output.stack) : output);
        return;
      }
      else if (exitCodeName === 'success') {
        if (_.isUndefined(output)) {
          try {
            if (
              !_.isUndefined(liveMachine.exits.success.example) ||
              _.isFunction(liveMachine.exits.success.getExample) ||
              !_.isUndefined(liveMachine.exits.success.like) ||
              !_.isUndefined(liveMachine.exits.success.itemOf)
            ) {
              // TODO: support json-encoded output vs colors
              console.log(util.inspect(output, {depth: null, colors: true}));
            }
          }
          catch (e) { /* fail silently if anything goes awry */ }
        }
        // Otherwise, output is expected.  So log it.
        else {
          console.log(chalk.green('OK.'));
        }
      }
      // Miscellaneous exit.
      else {
        console.log(chalk.cyan('Something went wrong:'));
        console.error(output.stack ? chalk.gray(output.stack) : output);
      }
    };//</callback definition>
  });//</each exit>


  // Now intercept `.exec()` to take care of sails.lower(), if relevant.
  // (we have to do this because any of the callbacks above _could_ be overridden!)
  var _originalExecBeforeItWasChangedForUseByMachineAsScript = liveMachine.exec;
  liveMachine.exec = function () {
    var args = Array.prototype.slice.call(arguments);

    // If we're not managing a Sails app instance for this script, then just do the normal thing.
    if (_.isUndefined(sailsApp)) {
      if (_.isObject(args[0])) {
        var combinedCbs = _.extend({}, callbacks, args[0]);
        _originalExecBeforeItWasChangedForUseByMachineAsScript.apply(liveMachine, [combinedCbs]);
      }
      else if (_.isFunction(args[0])) {
        _originalExecBeforeItWasChangedForUseByMachineAsScript.apply(liveMachine, [args[0]]);
      }
      else {
        _originalExecBeforeItWasChangedForUseByMachineAsScript.apply(liveMachine, [callbacks]);
      }
      return;
    }

    // --• Otherwise, we need to load Sails first, then lower it afterwards.
    // Load the Sails app.
    sailsApp.load(function (err){
      if (err) {
        throw new Error('This script relies on access to Sails, but when attempting to load this Sails app automatically, an error occurred.  Details: '+err.stack);
      }

      // Run underlying .exec(), but intercept it to tear down the Sails app.
      _originalExecBeforeItWasChangedForUseByMachineAsScript.apply(liveMachine, [function (sbErr, successResult){
        sailsApp.lower(function (sailsLowerErr) {
          if (sailsLowerErr) {
            console.warn('This script relies on access to Sails, but when attempting to lower this Sails app automatically after running the script, an error occurred.  Details:',sailsLowerErr.stack);
            console.warn('Continuing to run the appropriate exit callback anyway...');
          }

          // Success
          if (!sbErr) {
            if (_.isObject(args[0])) {
              if (args[0].success) { args[0].success(successResult); }
              else { callbacks.success(successResult); }
            }
            else if (_.isFunction(args[0])) {
              args[0](undefined, successResult);
            }
            else { callbacks.success(successResult); }
          }
          // Some other exit (or catchall error)
          else {
            if (_.isObject(args[0]) && _.contains(_.keys(args[0]), sbErr.exit)) {
              args[0][sbErr.exit](sbErr.output);
            }
            else if (_.isFunction(args[0])) {
              args[0](sbErr);
            }
            else if (_.contains(_.keys(callbacks), sbErr.exit)) {
              callbacks[sbErr.exit](sbErr.output);
            }
            else { callbacks.error(sbErr); }
          }

        });//</after sails.lower()>
      }]);//</after calling underlying .exec()>

    });//</after sails.load()>
  };//</definition of our .exec() override>


  // If we're managing a Sails app instance for this script, then pass through `env.sails`.
  if (!_.isUndefined(sailsApp)) {
    liveMachine.setEnv({ sails: sailsApp });
  }

  // Set a telltale property to allow `bin/machine-as-script` to be more
  // intelligent about catching wet machine instances which are already wrapped
  // in a call to machine-as-script.  Realistically, this rarely matters since
  // script modules don't normally export anything, but it's here just in case.
  liveMachine._telltale = 'machine-as-script';

  // Return the ready-to-exec machine.
  return liveMachine;

};
