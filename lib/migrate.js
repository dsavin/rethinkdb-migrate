'use strict'

const EventEmitter = require('events')
const Fs = require('fs')
const Joi = require('joi')
const Mask = require('json-mask')
const Moment = require('moment')
const Path = require('path')

const internals = {}

const Migrate = function (opt) {
  emit('info', 'Validating options')()
  return validateOptions(opt)
    .then(emit('info', 'Connecting to Rethinkdb'))
    .then(connectToRethink)
    .then(createDbIfInexistent)
    .then(emit('info', 'Executing Migrations'))
    .then(executeMigration)
    .then(emit('info', 'Closing connection'))
    .then(closeConnection)
}

internals.emitter = new EventEmitter()

Migrate.emitter = internals.emitter

module.exports = Migrate

function validateOptions (options) {
  const schema = Joi.object().keys({
    op: Joi.string().valid('up', 'down').required()
      .description('Migration command'),
    driver: Joi.string().valid('rethinkdb', 'rethinkdbdash').default('rethinkdb')
      .description('Rethinkdb javascript driver'),
    migrationsTable: Joi.string().default('_migrations')
      .description('Table where meta information about migrations will be saved'),
    migrationsDirectory: Joi.string().default('migrations')
      .description('Directory where migration files will be saved'),
    relativeTo: Joi.string().default(process.cwd())
      .description('Root path from which migration directory will be searched'),
    host: Joi.any().when('driver', { is: 'rethinkdb', then: Joi.string().default('localhost'), otherwise: Joi.any().forbidden() })
      .description('The host to connect to, if using rethinkdb official driver'),
    port: Joi.any().when('driver', { is: 'rethinkdb', then: Joi.number().default(28015), otherwise: Joi.any().forbidden() })
      .description('The port to connect on, if using rethinkdb official driver'),
    db: Joi.string().required().description('Database name'),
    user: Joi.string().description('Rethinkdb user'),
    username: Joi.string().description('Rethinkdb username'),
    password: Joi.string().description('Rethinkdb password'),
    authKey: Joi.string().description('Rethinkdb authkey'),
    discovery: Joi.any().when('driver', { is: 'rethinkdb', then: Joi.any().forbidden(), otherwise: Joi.boolean() })
      .description('Whether or not the driver should try to keep a list of updated hosts'),
    pool: Joi.any().when('driver', { is: 'rethinkdb', then: Joi.any().forbidden(), otherwise: Joi.boolean().default(false) })
      .description('Whether or not to use a connection pool'),
    cursor: Joi.any().when('driver', { is: 'rethinkdb', then: Joi.any().forbidden(), otherwise: Joi.boolean().default(true) })
      .description('If true, cursors will not be automatically converted to arrays when using rethinkdbdash'),
    servers: Joi.any().when('driver', {
      is: 'rethinkdb',
      then: Joi.any().forbidden(),
      otherwise: Joi.array().items(Joi.object().keys({
        host: Joi.string()
          .description('The host to connect to'),
        port: Joi.number().default(28015)
          .description('The port to connect on')
      }))
    }),
     ssl: Joi.any()
  }).without('user', 'username', 'ssl').without('password', 'authKey', 'ssl').required()

  return new Promise((resolve, reject) => {
    Joi.validate(options, schema, (err, validated) => {
      if (err) {
        return reject(err)
      }

      resolve(validated)
    })
  })
}

function wait (options) {
  if (options.driver === 'rethinkdb') {
    return Promise.resolve(options)
  }

  return options.r.db(options.db).wait([
    { waitFor: 'ready_for_writes', timeout: 20 }
  ])
  .run(options.conn)
  .then(() => options)
}

function connectToRethink (options) {
  const r = selectDriver(options)

  return r.connect(Mask(options, 'host,port,user,username,password,authKey'))
    .then(conn => {
      return Object.assign({}, options, { r, conn })
    })
}

function selectDriver (options) {
  if (options.driver === 'rethinkdb') {
    return require('rethinkdb')
  }

  return require('rethinkdbdash')(Mask(options, 'user,username,password,authKey,discovery,pool,cursor,servers'))
}

function createDbIfInexistent (options) {
  const { r, conn, db } = options

  return r.dbList().run(conn)
    .then(toArray)
    .then(list => {
      if (list.indexOf(db) < 0) {
        emit('info', 'Creating db', db)()
        return r.dbCreate(db).run(conn)
      }
    })
    .then(() => {
      conn.use(db)
      return options
    })
    .then(wait)
}

function toArray (cursor) {
  if (Array.isArray(cursor)) {
    return Promise.resolve(cursor)
  }

  return cursor.toArray()
}

function executeMigration (options) {
  const proxyTable = {
    up: migrateUp,
    down: migrateDown
  }

  return proxyTable[options.op](options)
}

function migrateUp (options) {
  return getLatestMigrationExecuted(options)
    .then(latest => getUnExecutedMigrations(latest, options))
    .then(newerMigrations => runMigrations('up', newerMigrations, options))
    .then(emit('info', 'Saving metada'))
    .then(executedMigrations => saveExecutedMigrationsMetadata(executedMigrations, options))
    .then(() => options)
}

function migrateDown (options) {
  return getAllMigrationsExecuted(options)
    .then(migrations => loadMigrationsCode(migrations, options))
    .then(migrations => runMigrations('down', migrations, options))
    .then(emit('info', 'Clearing migrations table'))
    .then(() => clearMigrationsTable(options))
    .then(() => options)
}

function getLatestMigrationExecuted (options) {
  return ensureMigrationsTable(options)
    .then(() => getAllMigrationsExecuted(options))
    .then(migrations => {
      if (!migrations.length) {
        return {
          timestamp: Moment().year(1900)
        }
      }
      return migrations[0]
    })
}

function ensureMigrationsTable (options) {
  const { r, conn, migrationsTable } = options

  return r.tableList().run(conn)
    .then(toArray)
    .then(list => {
      if (list.indexOf(migrationsTable) < 0) {
        return r.tableCreate(migrationsTable).run(conn)
          .then(() => r.table(migrationsTable).indexCreate('timestamp').run(conn))
          .then(() => r.table(migrationsTable).indexWait().run(conn))
      }
    })
}

function getAllMigrationsExecuted (options) {
  const { r, conn, migrationsTable } = options

  return ensureMigrationsTable(options)
    .then(() => r.table(migrationsTable)
      .orderBy({ index: r.desc('timestamp') })
      .run(conn)
      .then(toArray)
    )
    .then(migrations => migrations.map(migration => Object.assign({}, migration, {
      timestamp: Moment.utc(migration.timestamp)
    })))
}

function getUnExecutedMigrations (latestExecutedMigration, options) {
  const { migrationsDirectory, relativeTo } = options
  const path = Path.resolve(relativeTo, migrationsDirectory)
  const migrationRegExp = /^(\d{14})-(.*)\.js$/

  return readMigrationFilenamesFromPath(path)
  .then(files => files.filter(file => file.match(migrationRegExp)))
  .then(migrationFiles => migrationFiles.map(filename => {
    const [, timestamp, name] = filename.match(migrationRegExp)

    return {
      timestamp: Moment.utc(timestamp, 'YYYYMMDDHHmmss'),
      name: name,
      filename
    }
  }))
  .then(migrations => filterMigrationsOlderThan(migrations, latestExecutedMigration.timestamp))
  .then(sortMigrations)
  .then(migrations => loadMigrationsCode(migrations, options))
}

function readMigrationFilenamesFromPath (path) {
  return new Promise((resolve, reject) => {
    Fs.readdir(path, (err, files) => {
      if (err) {
        return reject(err)
      }
      resolve(files)
    })
  })
}

function filterMigrationsOlderThan (migrations, reference) {
  return migrations.filter(migration => migration.timestamp.isAfter(Moment(reference)))
}

function loadMigrationsCode (migrations, options) {
  const { relativeTo, migrationsDirectory } = options
  const basePath = Path.resolve(relativeTo, migrationsDirectory)
  return migrations.map(migration => Object.assign({}, migration, { code: require(Path.resolve(basePath, migration.filename)) }))
}

function sortMigrations (migrations) {
  return migrations.sort((a, b) => {
    if (a.timestamp.isBefore(b.timestamp)) {
      return -1
    } else if (b.timestamp.isBefore(a.timestamp)) {
      return 1
    }
    return 0
  })
}

function runMigrations (direction, migrations, options) {
  const { r, conn } = options
  return migrations
    .reduce((chain, migration) =>
      chain.then(() => migration.code[direction](r, conn)
        .then(emit('info', `Executed migration ${migration.name} ${options.op}`))),
      Promise.resolve()
    )
    .then(() => migrations)
}

function saveExecutedMigrationsMetadata (migrations, options) {
  const { r, conn, migrationsTable } = options

  return migrations
    .map(migration => ({ timestamp: migration.timestamp.toISOString(), name: migration.name, filename: migration.filename }))
    .reduce((chain, migration) => chain.then(() => r.table(migrationsTable).insert(migration).run(conn)), Promise.resolve())
}

function clearMigrationsTable (options) {
  const { r, conn, migrationsTable } = options

  return r.table(migrationsTable).delete().run(conn)
}

function closeConnection (options) {
  const { r, conn } = options

  if (options.driver === 'rethinkdbdash' && options.pool) {
    return r.getPoolMaster().drain()
      .then(() => conn.close())
  }

  return conn.close()
}

function emit (name, data) {
  return function (arg) {
    internals.emitter.emit(name, data)
    return arg
  }
}
