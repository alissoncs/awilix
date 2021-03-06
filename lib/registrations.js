const Lifetime = require('./Lifetime')
const ResolutionMode = require('./ResolutionMode')
const isFunction = require('./isFunction')
const AwilixNotAFunctionError = require('./AwilixNotAFunctionError')

/**
 * Makes an options object based on defaults.
 *
 * @param  {object} defaults
 * Default options.
 *
 * @param  {*} input
 * The input to check and possibly assign to the resulting object
 * .
 * @return {object}
 */
const makeOptions = (defaults, input) => {
  return Object.assign({}, defaults, input)
}

/**
 * Given an options object, creates a fluid interface
 * to manage it.
 *
 * @param {*} returnValue
 * The object to return.
 *
 * @param  {object} opts
 * The options to manage.
 *
 * @return {object}
 * The interface.
 */
const makeFluidInterface = (obj) => {
  const setLifetime = (value) => {
    obj.lifetime = value
    return obj
  }

  const setResolutionMode = (value) => {
    obj.resolutionMode = value
    return obj
  }

  const inject = (injector) => {
    obj.injector = injector
    return obj
  }

  return {
    setLifetime,
    inject,
    transient: () => setLifetime(Lifetime.TRANSIENT),
    scoped: () => setLifetime(Lifetime.SCOPED),
    singleton: () => setLifetime(Lifetime.SINGLETON),
    setResolutionMode,
    proxy: () => setResolutionMode(ResolutionMode.PROXY),
    classic: () => setResolutionMode(ResolutionMode.CLASSIC)
  }
}

/**
 * Creates a simple value registration where the given value will always be resolved.
 *
 * @param  {string} name
 * The name to register the value as.
 *
 * @param  {*} value
 * The value to resolve.
 *
 * @return {object}
 * The registration.
 */
const asValue = (value) => {
  const resolve = () => {
    return value
  }

  return {
    resolve,
    lifetime: Lifetime.TRANSIENT
  }
}

module.exports.asValue = asValue

/**
 * Creates a factory registration, where the given factory function
 * will be invoked with `new` when requested.
 *
 * @param  {string} name
 * The name to register the value as.
 *
 * @param  {Function} fn
 * The function to register.
 *
 * @param {object} opts
 * Additional options for the resolver.
 *
 * @return {object}
 * The registration.
 */
const asFunction = (fn, opts) => {
  if (!isFunction(fn)) {
    throw new AwilixNotAFunctionError('asFunction', 'function', typeof fn)
  }

  const defaults = {
    lifetime: Lifetime.TRANSIENT
  }

  opts = makeOptions(defaults, opts)

  const resolve = generateResolve(fn)
  const result = {
    resolve,
    lifetime: opts.lifetime,
    injector: opts.injector,
    resolutionMode: opts.resolutionMode
  }
  result.resolve = resolve.bind(result)
  Object.assign(result, makeFluidInterface(result))
  return result
}

module.exports.asFunction = asFunction

/**
 * Like a factory registration, but for classes that require `new`.
 *
 * @param  {string} name
 * The name to register the value as.
 *
 * @param  {Class} Type
 * The function to register.
 *
 * @param {object} opts
 * Additional options for the resolver.
 *
 * @return {object}
 * The registration.
 */
const asClass = (Type, opts) => {
  if (!isFunction(Type)) {
    throw new AwilixNotAFunctionError('asClass', 'class', typeof Type)
  }

  const defaults = {
    lifetime: Lifetime.TRANSIENT
  }

  opts = makeOptions(defaults, opts)

  // A function to handle object construction for us, as to make the generateResolve more reusable
  const newClass = function newClass () {
    return new Type(...arguments)
  }

  const resolve = generateResolve(newClass, Type.prototype.constructor)
  const result = {
    lifetime: opts.lifetime,
    injector: opts.injector,
    resolutionMode: opts.resolutionMode
  }
  result.resolve = resolve.bind(result)
  Object.assign(result, makeFluidInterface(result))

  return result
}

/**
 * Returns a wrapped `resolve` function that provides values
 * from the injector and defers to `container.resolve`.
 *
 * @param  {AwilixContainer} container
 * @param  {Function} injector
 * @return {Function}
 */
function wrapWithInjector (container, injector) {
  return function wrappedResolve (name) {
    const locals = injector(container)
    if (name in locals) {
      return locals[name]
    }

    return container.resolve(name)
  }
}

/**
 * Returns a new Proxy that checks the result from `injector`
 * for values before delegating to the actual container.
 *
 * @param  {Object} cradle
 * @param  {Function} injector
 * @return {Object}
 */
function createInjectorProxy (container, injector) {
  const wrappedResolve = wrapWithInjector(container, injector)
  return new Proxy({}, {
    get (target, property) {
      return wrappedResolve(property)
    }
  })
}

/**
 * Returns a resolve function used to construct the dependency graph
 *
 * @this {Registration}
 * The `this` context is a registration.
 *
 * @param {Function} fn
 * The function to construct
 *
 * @param {Function} dependencyParseTarget
 * The function to parse for the dependencies of the construction target
 *
 * @param {boolean} isFunction
 * Is the resolution target an actual function or a mask for a constructor?
 *
 * @return {Function}
 * The function used for dependency resolution
 */
function generateResolve (fn, dependencyParseTarget) {
  // If the function used for dependency parsing is falsy, use the supplied function
  if (!dependencyParseTarget) {
    dependencyParseTarget = fn
  }

  // Try to resolve the dependencies
  const dependencies = parseDependencies(dependencyParseTarget)

  // Use a regular function instead of an arrow function to facilitate binding to the registration.
  return function resolve (container) {
    // Because the container holds a global reolutionMode we need to determine it in the proper order or precedence:
    // registration -> container -> default value
    const resolutionMode = (this.resolutionMode || container.options.resolutionMode || ResolutionMode.PROXY)
    if (resolutionMode !== ResolutionMode.CLASSIC) {
      // If we have a custom injector, we need to wrap the cradle.
      const cradle = this.injector
        ? createInjectorProxy(container, this.injector)
        : container.cradle

      // Return the target injected with the cradle
      return fn(cradle)
    }

    // We have dependencies so we need to resolve them manually
    if (dependencies.length > 0) {
      const resolve = this.injector
        ? wrapWithInjector(container, this.injector)
        : container.resolve

      const children = dependencies.map(resolve)
      return fn(...children)
    }

    return fn()
  }
}

/**
 * Regex used for parsing dependencies for a function.
 */
const DEPS_EXPR = /(\(\s*([^)]+?)\s*\)|\(\))/

/**
 * Runs a regex on a function to return dependencies
 *
 * @param {function} function
 * A function to test
 *
 * @return {Array<string>}
 * Returns an array of dependency names
 */
function parseDependencies (func) {
  const args = DEPS_EXPR.exec(func.toString())
  if (args && args[2] && !args[2].includes('{') && !args[2].includes('}')) {
    return args[2].split(/\s*,\s*/)
  }
  return []
}

module.exports.asClass = asClass
