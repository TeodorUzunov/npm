'use strict'
var assert = require('assert')
var fs = require('fs')
var path = require('path')
var semver = require('semver')
var asyncMap = require('slide').asyncMap
var chain = require('slide').chain
var union = require('lodash.union')
var without = require('lodash.without')
var iferr = require('iferr')
var npa = require('npm-package-arg')
var validate = require('aproba')
var realizePackageSpecifier = require('realize-package-specifier')
var fetchPackageMetadata = require('../fetch-package-metadata.js')
var andAddParentToErrors = require('./and-add-parent-to-errors.js')
var addShrinkwrap = require('../fetch-package-metadata.js').addShrinkwrap
var addBundled = require('../fetch-package-metadata.js').addBundled
var inflateShrinkwrap = require('./inflate-shrinkwrap.js')
var andFinishTracker = require('./and-finish-tracker.js')
var npm = require('../npm.js')
var flatName = require('./flatten-tree.js').flatName

// The export functions in this module mutate a dependency tree, adding
// items to them.

function isDep(tree, child) {
  var deps = tree.package.dependencies || {}
  var devDeps = tree.package.devDependencies || {}
  return deps[child.package.name] || devDeps[child.package.name]
}

var recalculateMetadata = exports.recalculateMetadata = function (tree, log, next) {
  if (!tree.children) tree.children = []
  tree.requires = []
  if (!tree.package) tree.package = {}
  if (!tree.package.dependencies) tree.package.dependencies = {}
  if (!tree.package.devDependencies) tree.package.devDependencies = {}
  if (tree.package._requiredBy) {
    var byUser = tree.package._requiredBy.filter(function (req) { return req === "#USER" })
    tree.package._requiredBy = byUser ? byUser : []
  }
  else if (tree.parent && tree.parent != null) {
    tree.package._requiredBy = ["#EXISTING"]
  }
  else {
    tree.package._requiredBy = []
  }
  tree.package._phantomChildren = {}
  function markDeps (spec, done) {
    realizePackageSpecifier(spec, tree.path, function (er, req) {
      if (er) return done()
      var child = findRequirement(tree, req.name, req)
      if (!child) return done()
      resolveWithExistingModule(child, child.package, tree, log, function () { done() })
    })
  }
  function deptospec(deps) {
    return function (depname) {
      return depname + '@' + deps[depname]
    }
  }
  var tomark = union(
    Object.keys(tree.package.dependencies).map(deptospec(tree.package.dependencies)),
    tree.parent == null
      ? Object.keys(tree.package.devDependencies).map(deptospec(tree.package.devDependencies))
      : []
  )
  chain([
    [asyncMap, tomark, markDeps],
    [asyncMap, tree.children, function (child, done) { recalculateMetadata(child, log, done) }]
  ], function () { next(null, tree) })
}

// Add a list of args to tree's top level dependencies
exports.loadRequestedDeps = function (args, tree, saveToDependencies, log, next) {
  validate('AOBOF', arguments)
  asyncMap(args, function (spec, done) {
    replaceDependency(spec, tree, log.newGroup('loadRequestedDeps'), iferr(done, function (child, tracker) {
      validate('OO', arguments)
      if (npm.config.get('global')) {
        child.isGlobal = true
      }
      child.directlyRequested = true
      child.save = saveToDependencies

      // For things the user asked to install, that aren't a dependency (or
      // won't be when we're done), flag it as "depending" on the user
      // themselves, so we don't remove it as a dep that no longer exists
      if (!child.save && !isDep(tree, child)) {
        child.package._requiredBy = union(child.package._requiredBy, ['#USER'])
      }
      done(null, child, tracker)
    }))
  }, andLoadDeps(andFinishTracker(log, next)))
}

exports.removeDeps = function (args, tree, saveToDependencies, log, next) {
  validate('AOBOF', arguments)
  asyncMap(args, function (name, done) {
    tree.children = tree.children.filter(function (child) { return child.package.name !== name })
    done()
  }, andFinishTracker(log, next))
}

function andLoadDeps (next) {
  validate('F', [next])
  return function (er, children, logs) {
    // when children is empty, logs won't be passed in at all (asyncMap is weird)
    // so shortcircuit before arg validation
    if (!er && (!children || children.length === 0)) return next()
    validate('EAA', arguments)
    if (er) return next(er)
    assert(children.length === logs.length)
    var cmds = []
    for (var ii = 0; ii < children.length; ++ii) {
      cmds.push([loadDeps, children[ii], logs[ii]])
    }
    var sortedCmds = cmds.sort(function installOrder (aa, bb) {
      return aa[1].package.name.localeCompare(bb[1].package.name)
    })
    chain(sortedCmds, next)
  }
}

function depAdded (done) {
  validate('F', arguments)
  return function () {
    validate('EOO', arguments)
    done.apply(null, arguments)
  }
}

// Load any missing dependencies in the given tree
exports.loadDeps = loadDeps
function loadDeps (tree, log, next) {
  validate('OOF', arguments)
  if (tree.loaded) return andFinishTracker.now(log, next)
  tree.loaded = true
  if (!tree.package.dependencies) tree.package.dependencies = {}
  asyncMap(Object.keys(tree.package.dependencies), function (dep, done) {
    var version = tree.package.dependencies[dep]
    if (tree.package.optionalDependencies &&
        tree.package.optionalDependencies[dep]) {
      done = andWarnOnError(log, done)
    }
    var spec = dep + '@' + version
    addDependency(spec, tree, log.newGroup('loadDep:' + dep), depAdded(done))
  }, andLoadDeps(andFinishTracker(log, next)))
}

function andWarnOnError (log, next) {
  validate('OF', arguments)
  return function (er, child, childLog) {
    validate('EOO', arguments)
    if (er) {
      log.warn('install', "Couldn't install optional dependency:", er.message)
      log.verbose('install', er.stack)
    }
    next(null, child, childLog)
  }
}

// Load development dependencies into the given tree
exports.loadDevDeps = function (tree, log, next) {
  validate('OOF', arguments)
  if (!tree.package.devDependencies) return andFinishTracker.now(log, next)
  asyncMap(Object.keys(tree.package.devDependencies), function (dep, done) {
    // things defined as both dev dependencies and regular dependencies are treated
    // as the former
    if (tree.package.dependencies[dep]) return done()

    var spec = dep + '@' + tree.package.devDependencies[dep]
    var logGroup = log.newGroup('loadDevDep:' + dep)
    addDependency(spec, tree, logGroup, iferr(done, function (child, tracker) {
      validate('OO', arguments)
      child.devDependency = true
      done(null, child, tracker)
    }))
  }, andLoadDeps(andFinishTracker(log, next)))
}

exports.loadExtraneous = function (tree, log, next) {
  validate('OOF', arguments)
  asyncMap(tree.children.filter(function (child) { return !child.loaded }), function (child, done) {
    resolveWithExistingModule(child, child.package, tree, log, done)
  }, andLoadDeps(andFinishTracker(log, next)))
//  andLoadDeps(next)(null, tree.children, tree.children.map(function () { return log }))
}

function replaceDependency (spec, tree, log, cb) {
  validate('SOOF', arguments)
  var next = andAddParentToErrors(tree, cb)
  fetchPackageMetadata(spec, tree.path, log.newItem('fetchMetadata'), iferr(next, function (pkg) {
    tree.children = tree.children.filter(function (child) {
      return child.package.name !== pkg.name
    })
    resolveRequirement(pkg, tree, log, next)
  }))
}

function addDependency (spec, tree, log, done) {
  validate('SOOF', arguments)
  var cb = function (er, child, log) {
    validate('EOO', arguments)
    if (er) return done(er)
    done(null, child, log)
  }
  var next = andAddParentToErrors(tree, cb)
  fetchPackageMetadata(spec, tree.path, log.newItem('fetchMetadata'), iferr(next, function (pkg) {
    var child = findRequirement(tree, pkg.name, npa(spec))
    if (child) {
      resolveWithExistingModule(child, pkg, tree, log, next)
    } else {
      resolveRequirement(pkg, tree, log, next)
    }
  }))
}

function resolveWithExistingModule (child, pkg, tree, log, next) {
  validate('OOOOF', arguments)
  if (!child.package._requested) {
    if (pkg._requested && semver.satisfies(child.package.version, pkg._requested.spec)) {
      child.package._requested = pkg._requested
    } else {
      child.package._requested = {
        spec: child.package.version,
        type: 'version'
      }
    }
  }
  if (child.package._requested.spec !== pkg._requested.spec) {
    child.package._requested.spec += ' ' + pkg._requested.spec
    child.package._requested.type = 'range'
  }
  if (isDep(tree, child)) {
    child.package._requiredBy = union(child.package._requiredBy || [], [flatNameFromTree(tree)])
  }

  tree.requires = union(tree.requires || [], [child])
  pushUnique(tree, 'requires', child)

  if (tree.parent && child.parent !== tree) updatePhantomChildren(tree.parent, child)

  if (!child.loaded && pkg._shrinkwrap === undefined) {
    fs.readFile(path.join(child.path, 'npm-shrinkwrap.json'), function (er, data) {
      if (er) {
        pkg._shrinkwrap = null
        return next(null, child, log)
      }
      try {
        pkg._shrinkwrap = JSON.parse(data)
      } catch (ex) {
        return next(null, child, log)
      }
      if (pkg._shrinkwrap && pkg._shrinkwrap.dependencies) {
        return inflateShrinkwrap(child, pkg._shrinkwrap.dependencies, iferr(next, function () {
          next(null, child, log)
        }))
      } else {
        return next(null, child, log)
      }
    })
  } else {
    return next(null, child, log)
  }
}

var updatePhantomChildren = exports.updatePhantomChildren = function (current, child) {
  validate('OO', arguments)
  while (current && current !== child.parent) {
    // FIXME: phantomChildren doesn't actually belong in the package.json
    if (!current.package._phantomChildren) current.package._phantomChildren = {}
    current.package._phantomChildren[child.package.name] = child.package.version
    current = current.parent
  }
}

function pushUnique (obj, key, element) {
  validate('OSO', arguments)
  if (!obj[key]) obj[key] = []
  if (without(obj[key], element).length === 0) {
    obj[key].push(element)
  }
}

function flatNameFromTree (tree) {
  validate('O', arguments)
  if (!tree.parent) return '/'
  var path = flatNameFromTree(tree.parent)
  if (path !== '/') path += '/'
  return flatName(path, tree)
}

function resolveRequirement (pkg, tree, log, next) {
  validate('OOOF', arguments)
  pkg._from = pkg._requested.name + '@' + pkg._requested.spec
  addShrinkwrap(pkg, iferr(next, function () {
    addBundled(pkg, iferr(next, function () {
      var child = {
        package: pkg,
        children: [],
        requires: []
      }

      child.parent = earliestInstallable(tree, tree, pkg) || tree
      child.parent.children.push(child)
      if (!child.package._requiredBy) child.package._requiredBy = []
      if (isDep(tree, child)) {
        child.package._requiredBy = union(child.package._requiredBy || [], [flatNameFromTree(tree)])
      }

      if (tree.parent && child.parent !== tree) updatePhantomChildren(tree.parent, child)

      tree.requires = union(tree.requires || [], [child])

      pushUnique(tree, 'requires', child)

      child.path = path.join(child.parent.path, 'node_modules', pkg.name)
      child.realpath = path.resolve(child.parent.realpath, 'node_modules', pkg.name)

      if (pkg._bundled) {
        child.children = pkg._bundled
        inflateBundled(child, child.children)
      }

      if (pkg._shrinkwrap && pkg._shrinkwrap.dependencies) {
        return inflateShrinkwrap(child, pkg._shrinkwrap.dependencies, function () {
          next(null, child, log)
        })
      }

      next(null, child, log)
    }))
  }))
}

function inflateBundled (parent, children) {
  validate('OA', arguments)
  children.forEach(function (child) {
    child.fromBundle = true
    child.parent = parent
    child.path = path.join(parent.path, child.package.name)
    child.realpath = path.resolve(parent.path, child.package.name)
    inflateBundled(child, child.children)
  })
}

exports.validatePeerDeps = function validatePeerDeps (tree, log) {
  validate('OO', arguments)
  if (tree.package.peerDependencies) {
    Object.keys(tree.package.peerDependencies).forEach(function (pkgname) {
      var version = tree.package.peerDependencies[pkgname]
      var match = findRequirement(tree, pkgname, npa(version))
      if (!match) {
        log.warn('validatePeerDeps', tree.package.name + '@' + tree.package.version +
          ' requires a peer of ' + pkgname + '@' + version + ' but none was installed.')
      }
    })
  }
  tree.children.forEach(function (child) { validatePeerDeps(child, log) })
}

// Determine if a module requirement is already met by the tree at or above
// our current location in the tree.
var findRequirement = exports.findRequirement = function (tree, name, requested) {
  validate('OSO', arguments)
  var nameMatch = function (child) {
    return child.package.name === name && child.parent
  }
  var versionMatch = function (child) {
    var childReq = child.package._requested
    if (childReq && childReq.type === requested.type && childReq.spec === requested.spec) return true
    if (requested.type !== 'range' && requested.type !== 'version') return false
    return semver.satisfies(child.package.version, requested.spec)
  }
  if (nameMatch(tree)) {
    // this *is* the module, but it doesn't match the version, so a
    // new copy will have to be installed
    return versionMatch(tree) ? tree : null
  }

  var matches = tree.children.filter(nameMatch)
  if (matches.length) {
    matches = matches.filter(versionMatch)
    // the module exists as a dependent, but the version doesn't match, so
    // a new copy will have to be installed above here
    if (matches.length) return matches[0]
    return null
  }
  if (!tree.parent) return null
  return findRequirement(tree.parent, name, requested)
}

// Find the highest level in the tree that we can install this module in.
// If the module isn't installed above us yet, that'd be the very top.
// If it is, then it's the level below where its installed.
var earliestInstallable = exports.earliestInstallable = function (requiredBy, tree, pkg) {
  validate('OOO', arguments)
  var nameMatch = function (child) {
    return child.package.name === pkg.name
  }

  var nameMatches = tree.children.filter(nameMatch)
  if (nameMatches.length) return null

  // If any of the children of this tree have conflicting
  // binaries then we need to decline to install this package here.
  var binaryMatches = tree.children.filter(function (child) {
    return Object.keys(child.package.bin || {}).filter(function (bin) {
      return pkg.bin && pkg.bin[bin]
    }).length
  })
  if (binaryMatches.length) return null

  // if this tree location requested the same module then we KNOW it
  // isn't compatible because if it were findRequirement would have
  // found that version.
  if (requiredBy !== tree && tree.package.dependencies && tree.package.dependencies[pkg.name]) {
    return null
  }

  // FIXME: phantomChildren doesn't actually belong in the package.json
  if (tree.package._phantomChildren && tree.package._phantomChildren[pkg.name]) return null

  if (!tree.parent) return tree
  if (tree.isGlobal) return tree

  return (earliestInstallable(requiredBy, tree.parent, pkg) || tree)
}