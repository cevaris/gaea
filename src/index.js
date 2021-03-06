const grpc = require('grpc')
const path = require('path')
const access = require('object-access')
const debug = require('util').debuglog('gaea')
const {isNumber} = require('core-util-is')
const forEach = require('lodash.foreach')

const readConfig = require('./config')
const {wrap, unwrap} = require('./error')

const STR_DOT = '.'
const packageToPaths = pkg => pkg.split(STR_DOT)
const serviceMethodNames = service_def =>
  Object.keys(service_def)
  .map(name => {
    const {originalName} = service_def[name]
    return {
      originalName,
      name
    }
  })

const wrapServerMethod = (method, error_props) => (call, callback) => {
  Promise.resolve()
  .then(() => method(call.request, call))
  .then(
    res => callback(null, res),
    err => {
      debug('wrapServerMethod: error: %s', err && err.stack || err.message || err)

      callback(wrap(err, error_props))
    }
  )
}

const iterateProtos = (protos, iteratee) => {
  protos.forEach(({
    def
  }) => {
    const grpc_object = grpc.loadPackageDefinition(def)

    forEach(def, (
      // Greeter methods
      service_def,
      // 'helloworld.Greeter'
      package_name
    ) => {
      const service = access(grpc_object, package_name)
      const methods = serviceMethodNames(service_def)

      iteratee({
        service,
        package_name,
        methods
      })
    })
  })
}

class Server {
  constructor (options) {
    this._options = options
    this._server = new grpc.Server()

    this._init()
  }

  _init () {
    const {
      protos
    } = this._options

    iterateProtos(protos, ({
      service,
      package_name,
      methods
    }) => {
      this._addService(service.service, package_name, methods)
    })
  }

  _getServiceMethods (package_name) {
    const p = path.join(
      this._options.service_root,
      ...packageToPaths(package_name)
    )

    try {
      return {
        service_path: p,
        methods: require(p)
      }
    } catch (err) {
      // TODO:better error message for different situations
      throw new Error(
        `fails to load service controller "${p}" for "${package_name}"`
      )
    }
  }

  _addService (service, package_name, required_methods) {
    const {
      service_path,
      methods
    } = this._getServiceMethods(package_name)

    const {error_props} = this._options

    const wrapped = {}

    required_methods.forEach(({name, originalName}) => {
      const method = methods[name] || methods[originalName]

      if (!method) {
        throw new Error(`method "${name}" is required in "${service_path}"`)
      }

      wrapped[name] = wrapServerMethod(method, error_props)
    })

    this._server.addService(service, wrapped)
  }

  // TODO: more options to define server credentials
  listen (port) {
    if (!isNumber(port)) {
      throw new TypeError(`port must be a number, but got \`${port}\``)
    }

    const server = this._server

    server.bind(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure())
    server.start()
  }
}

const wrapClientMethods = (real_client, methods, error_props) => {
  const client = {}

  methods.forEach(({name, originalName}) => {
    const method = req => new Promise((resolve, reject) => {
      real_client[name](req, (err, res) => {
        if (err) {
          const error = unwrap(err, error_props)

          debug('wrapClientMethod: error: %s',
            error.stack || error.message || error)

          return reject(error)
        }

        resolve(res)
      })
    })

    client[name] = method

    if (name !== originalName) {
      client[originalName] = method
    }
  })

  return client
}

class Client {
  constructor (host, options) {
    this._host = host
    this._options = options
  }

  create () {
    const {
      protos,
      error_props
    } = this._options

    const clients = {}

    iterateProtos(protos, ({
      service: Service,
      package_name,
      methods
    }) => {
      const client = new Service(this._host, grpc.credentials.createInsecure())

      access.set(
        clients, package_name,
        wrapClientMethods(client, methods, error_props)
      )
    })

    return clients
  }
}

class Gaea {
  constructor (root) {
    this._options = readConfig(root)

    this.client = this.client.bind(this)
  }

  client (host) {
    return new Client(host, this._options).create()
  }

  get server () {
    return new Server(this._options)
  }
}

exports.load = root => new Gaea(root)
