/* e
 * Copyright (c) 2017-present, Block Collider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { BcBlock } from '../protos/core_pb'

const ROVERS = Object.keys(require('../rover/manager').rovers)

const debug = require('debug')('bcnode:engine')
const { EventEmitter } = require('events')
const { queue } = require('async')
const { equals, all, values } = require('ramda')
const { fork, ChildProcess } = require('child_process')
const { resolve } = require('path')
const { writeFileSync } = require('fs')
const LRUCache = require('lru-cache')
const BN = require('bn.js')
const semver = require('semver')
const fetch = require('node-fetch')

const { config } = require('../config')
const { isDebugEnabled, ensureDebugPath } = require('../debug')
const { Multiverse } = require('../bc/multiverse')
const logging = require('../logger')
const { Monitor } = require('../monitor')
const { Node } = require('../p2p')
const RoverManager = require('../rover/manager').default
const rovers = require('../rover/manager').rovers
const Server = require('../server/index').default
const PersistenceRocksDb = require('../persistence').RocksDb
const { PubSub } = require('./pubsub')
const { RpcServer } = require('../rpc/index')
const { prepareWork, prepareNewBlock } = require('../bc/miner')
const { getGenesisBlock } = require('../bc/genesis')
const { BlockPool } = require('../bc/blockpool')
const { isValidBlock } = require('../bc/validation')
const { getBlockchainsBlocksCount } = require('../bc/helper')
const { Block } = require('../protos/core_pb')
const { errToString } = require('../helper/error')
const { getVersion } = require('../helper/version')
const ts = require('../utils/time').default // ES6 default export

const DATA_DIR = process.env.BC_DATA_DIR || config.persistence.path
const MONITOR_ENABLED = process.env.BC_MONITOR === 'true'
const PERSIST_ROVER_DATA = process.env.PERSIST_ROVER_DATA === 'true'
const MINER_WORKER_PATH = resolve(__filename, '..', '..', 'bc', 'miner_worker.js')

type UnfinishedBlockData = {
  lastPreviousBlock: ?BcBlock,
  block: ?Block,
  currentBlocks: ?{ [blokchain: string]: Block },
  iterations: ?number,
  timeDiff: ?number
}

export default class Engine {
  _logger: Object; // eslint-disable-line no-undef
  _monitor: Monitor; // eslint-disable-line no-undef
  _knownBlocksCache: LRUCache<string, BcBlock>; // eslint-disable-line no-undef
  _rawBlocks: LRUCache<number, Block>; // eslint-disable-line no-undef
  _node: Node; // eslint-disable-line no-undef
  _persistence: PersistenceRocksDb; // eslint-disable-line no-undef
  _pubsub: PubSub; //  eslint-disable-line no-undef
  _rovers: RoverManager; // eslint-disable-line no-undef
  _rpc: RpcServer; // eslint-disable-line no-undef
  _server: Server; // eslint-disable-line no-undef
  _emitter: EventEmitter; // eslint-disable-line no-undef
  _knownRovers: string[]; // eslint-disable-line no-undef
  _minerKey: string; // eslint-disable-line no-undef
  _collectedBlocks: Object; // eslint-disable-line no-undef
  _verses: Multiverse[]; // eslint-disable-line no-undef
  _canMine: bool; // eslint-disable-line no-undef
  _workerProcess: ?ChildProcess
  _unfinishedBlock: ?BcBlock
  _rawBlock: Block[]
  _subscribers: Object
  _unfinishedBlockData: ?UnfinishedBlockData
  _peerIsSyncing: boolean
  _peerIsResyncing: boolean
  _storageQueue: any

  constructor (logger: Object, opts: { rovers: string[], minerKey: string}) {
    this._logger = logging.getLogger(__filename)
    this._knownRovers = opts.rovers
    this._minerKey = opts.minerKey
    this._rawBlock = []
    this._monitor = new Monitor(this, {})
    this._persistence = new PersistenceRocksDb(DATA_DIR)
    this._pubsub = new PubSub()
    this._node = new Node(this)
    this._rovers = new RoverManager()
    this._emitter = new EventEmitter()
    this._rpc = new RpcServer(this)
    this._server = new Server(this, this._rpc)
    this._collectedBlocks = {}
    this._subscribers = {}
    this._verses = []
    for (let roverName of this._knownRovers) {
      this._collectedBlocks[roverName] = 0
    }
    this._canMine = false
    this._unfinishedBlockData = { block: undefined, lastPreviousBlock: undefined, currentBlocks: {}, timeDiff: undefined, iterations: undefined }
    this._storageQueue = queue((fn, cb) => {
      return fn.then((res) => { cb(null, res) }).catch((err) => { cb(err) })
    })

    this._knownBlocksCache = LRUCache({
      max: 1024
    })

    this._rawBlocks = LRUCache({
      max: 5
    })

    this._peerIsSyncing = false
    this._peerIsResyncing = false
    // Start NTP sync
    ts.start()
  }

  get minerKey (): ?string {
    return this._minerKey
  }

  /**
   * Get multiverse
   * @returns {Multiverse|*}
   */
  get multiverse (): Multiverse {
    return this.node.multiverse
  }

  /**
   * Get blockpool
   * @returns {BlockPool|*}
   */
  get blockpool (): BlockPool {
    return this.node.blockpool
  }

  /**
   * Get pubsub wrapper instance
   * @returns {PubSub}
   */
  get pubsub (): PubSub {
    return this._pubsub
  }

  /**
   * Initialize engine internals
   *
   * - Open database
   * - Store name of available rovers
   */
  async init () {
    const self = this
    const roverNames = Object.keys(rovers)
    const { npm, git: { long } } = getVersion()
    const newGenesisBlock = getGenesisBlock()
    const versionData = {
      version: npm,
      commit: long,
      db_version: 1
    }
    const engineQueue = queue((fn, cb) => {
      return fn.then((res) => { cb(null, res) }).catch((err) => { cb(err) })
    })
    const DB_LOCATION = resolve(`${__dirname}/../../${this.persistence._db.location}`)
    const DELETE_MESSAGE = `Your DB version is old, please delete data folder '${DB_LOCATION}' and run bcnode again`
    // TODO get from CLI / config
    try {
      await this._persistence.open()
      try {
        let version = await this.persistence.get('appversion')
        if (semver.lt(version.version, '0.6.0')) {
          this._logger.warn(DELETE_MESSAGE)
          process.exit(8)
        }
      } catch (_) {
        // silently continue - the version is not present so
        // a) very old db
        // b) user just remove database so let's store it
      }
      let res = await this.persistence.put('rovers', roverNames)
      if (res) {
        this._logger.debug('Stored rovers to persistence')
      }
      res = await this.persistence.put('appversion', versionData)
      if (res) {
        this._logger.debug('Stored appversion to persistence')
      }
      try {
        await this.persistence.get('bc.block.1')
        const latestBlock = await this.persistence.get('bc.block.latest')
        self._logger.info('highest block height on disk ' + latestBlock.getHeight())
        self.multiverse.addBlock(latestBlock)
        self.multiverse._selective = true
        this._logger.info('Genesis block present, everything ok')
      } catch (_) { // genesis block not found
        try {
          await this.persistence.put('bc.block.1', newGenesisBlock)
          await this.persistence.put('bc.block.latest', newGenesisBlock)
          self.multiverse.addBlock(newGenesisBlock)
          this._logger.info('Genesis block saved to disk ' + newGenesisBlock.getHash())
        } catch (e) {
          this._logger.error(`Error while creating genesis block ${e.message}`)
          this.requestExit()
          process.exit(1)
        }
      }
    } catch (e) {
      this._logger.warn(`Could not store rovers to persistence, reason ${e.message}`)
    }

    if (MONITOR_ENABLED) {
      this._monitor.start()
    }

    this._logger.debug('Engine initialized')

    self.pubsub.subscribe('state.block.height', '<engine>', (msg) => {
      self.storeHeight(msg).then((res) => {
        if (res === true) {
          self._logger.info('wrote block ' + msg.data.getHeight())
        }
      }).catch((err) => {
        console.trace(err)
        self._logger.error(err)
      })
    })

    self.pubsub.subscribe('update.checkpoint.start', '<engine>', (msg) => {
      self._peerIsResyncing = true
    })

    self.pubsub.subscribe('state.resync.failed', '<engine>', (msg) => {
      self._logger.info('pausing mining to reestablish multiverse')
      self._peerIsResyncing = true
      engineQueue.push(self.blockpool.purge(msg.data), function (err, data) {
        if (err) {
          console.trace(err)
          self._logger.error(err)
        }
      })
    })

    self.pubsub.subscribe('state.checkpoint.end', '<engine>', (msg) => {
      self._peerIsResyncing = false
    })

    self.pubsub.subscribe('update.block.latest', '<engine>', (msg) => {
      self.updateLatestAndStore(msg).then((res) => {
        console.log('latest block ' + msg.data.getHeight() + ' has been updated')
        self._logger.info('latest block ' + msg.data.getHeight() + ' has been updated')
      })
        .catch((err) => {
          console.trace(err)
          self._logger.error(err)
        })
    })
  }

  /**
   * Store a block in persistence unless its Genesis Block
   * @returns Promise
   */
  async storeHeight (msg: Object) {
    const self = this
    const block = msg.data
    // Block is genesis block
    if (block.getHeight() < 2) {
      return
    }
    if (msg.force !== undefined && msg.force === true) {
      try {
        await self.persistence.put('bc.block.' + block.getHeight(), block)
        return Promise.resolve(block)
      } catch (err) {
        self._logger.warn('unable to store block ' + block.getHeight() + ' - ' + block.getHash())
        return Promise.reject(err)
      }
    } else {
      try {
        const prev = await self.persistence.get('bc.block.' + (block.getHeight() - 1))
        if (prev.getHash() === block.getPreviousHash() &&
          new BN(prev.getTotalDistance()).lt(new BN(block.getTotalDistance()) === true)) {
          await self.persistence.put('bc.block.' + block.getHeight(), block)
          return Promise.resolve(true)
        } else {
          return Promise.reject(new Error('block state did not match'))
        }
      } catch (err) {
        await self.persistence.put('bc.block.' + block.getHeight(), block)
        self._logger.warn(' stored orphan ' + block.getHeight() + ' - ' + block.getHash())
        return Promise.resolve(true)
      }
    }
  }

  /**
   * Store a block in persistence unless its Genesis Block
   * @returns Promise
   */
  async updateLatestAndStore (msg: Object) {
    const self = this
    const block = msg.data
    try {
      const previousLatest = await self.persistence.get('bc.block.latest')
      let persistNewBlock = false
      console.log('comparing new block ' + block.getHeight() + ' with the latest block at ' + previousLatest.getHeight())
      if (previousLatest.getHash() === block.getPreviousHash()) {
        persistNewBlock = true
      }
      if (msg.force !== undefined && msg.force === true) {
        // TODO: trigger purge
        persistNewBlock = true
      }
      if (persistNewBlock === true &&
         block.getTimestamp() >= previousLatest.getTimestamp()) { // notice you cannot create two blocks in the same second (for when BC moves to 1s block propogation waves)
        await self.persistence.put('bc.block.latest', block)
        await self.persistence.put('bc.block.' + block.getHeight(), block)
        if (self._workerProcess === undefined) {
          self._workerProcess = false
        }
      } else {
        self._logger.warn('new purposed latest block does not match the last')
      }
      if (msg.force !== undefined && msg.force === true && msg.multiverse !== undefined) {
        while (msg.multiverse.length > 0) {
          const b = msg.multiverse.pop()
          await self.persistence.put('bc.block.' + b.getHeight(), b)
        }
        return Promise.resolve(true)
      } else if (msg.force !== undefined && msg.force === true && msg.purge !== undefined) {
        return self.blockpool.purgeFrom(block.getHeight(), msg.purge)
      } else {
        return Promise.resolve(true)
      }
    } catch (err) {
      self._logger.warn(err)
      if (block !== undefined) {
        await self.persistence.put('bc.block.latest', block)
        await self.persistence.put('bc.block.' + block.getHeight(), block)
      }
      return Promise.resolve(true)
    }
  }

  /**
   * Get node
   * @return {Node}
   */
  get node (): Node {
    return this._node
  }

  /**
   * Get rawBlock
   * @return {Object}
   */
  get rawBlock (): ?Object {
    return this._rawBlock
  }

  /**
   * Get rawBlock
   * @return {Object}
   */
  set rawBlock (block: Object): ?Object {
    this._rawBlock = block
  }

  /**
   * Get persistence
   * @return {Persistence}
   */
  get persistence (): PersistenceRocksDb {
    return this._persistence
  }

  /**
   * Get rovers manager
   * @returns RoverManager
   */
  get rovers (): RoverManager {
    return this._rovers
  }

  /**
   * Get instance of RpcServer
   * @returns RpcServer
   */
  get rpc (): RpcServer {
    return this._rpc
  }

  /**
   * Get instance of Server (Express on steroids)
   * @returns Server
   */
  get server (): Server {
    return this._server
  }

  /**
   * Start Server
   */
  startNode () {
    this._logger.info('Starting P2P node')
    this.node.start()

    this._emitter.on('peerConnected', ({ peer }) => {
      if (this._server) {
        this._server._wsBroadcastPeerConnected(peer)
      }
    })

    this._emitter.on('peerDisconnected', ({ peer }) => {
      if (this._server) {
        this._server._wsBroadcastPeerDisonnected(peer)
      }
    })
  }

  /**
   * Start rovers
   * @param rovers - list (string; comma-delimited) of rover names to start
   */
  startRovers (rovers: string[]) {
    this._logger.info(`Starting rovers '${rovers.join(',')}'`)

    rovers.forEach(name => {
      if (name) {
        this._rovers.startRover(name)
      }
    })
    this._emitter.on('collectBlock', ({ block }) => {
      process.nextTick(() => {
        fetch('http://council.blockcollider.org').then(res => res.text()).then(council => {
          this.collectBlock(rovers, block).then((pid: number|false) => {
            if (pid !== false) {
              this._logger.debug(`collectBlock handler: successfuly send to mining worker (PID: ${pid})`)
            }
          }).catch(err => {
            this._logger.error(`Could not send to mining worker, reason: ${errToString(err)}`)
            this._cleanUnfinishedBlock()
          })
        }).catch(_ => {
          this._logger.info('“Save Waves and NEO!” - After Block Collider miners completly brought down the Waves network 22 minutes into mining the team has paused the launch of genesis until we setup protections for centralized chains. Your NRG is safe.')
          process.exit(64)
        })
      })
    })
  }

  async collectBlock (rovers: string[], block: Block) {
    const self = this
    this._collectedBlocks[block.getBlockchain()] += 1

    // TODO: Adjust minimum count of collected blocks needed to trigger mining
    if (!this._canMine && all((numCollected: number) => numCollected >= 1, values(self._collectedBlocks))) {
      this._canMine = true
    }

    if (PERSIST_ROVER_DATA === true) {
      this._writeRoverData(block)
    }
    // start mining only if all known chains are being rovered
    if (this._canMine && !this._peerIsSyncing && equals(new Set(this._knownRovers), new Set(rovers))) {
      self._rawBlock.push(block)
      return self.startMining(rovers, block)
        .then((res) => {
          self._logger.info('mining cycle initiated')
        })
        .catch((err) => {
          self._logger.error(err)
        })
    } else {
      if (!this._canMine) {
        const keys = Object.keys(this._collectedBlocks)
        const values = '|' + keys.reduce((all, a, i) => {
          const val = this._collectedBlocks[a]
          if (i === (keys.length - 1)) {
            all = all + a + ':' + val
          } else {
            all = all + a + ':' + val + ' '
          }
          return all
        }, '') + '|'
        this._logger.info('constructing multiverse from blockchains ' + values)
        return Promise.resolve(false)
      }
      if (this._peerIsSyncing) {
        this._logger.info(`mining and ledger updates disabled until initial multiverse threshold is met`)
        return Promise.resolve(false)
      }
      this._logger.debug(`consumed blockchains manually overridden, mining services disabled, active multiverse rovers: ${JSON.stringify(rovers)}, known: ${JSON.stringify(this._knownRovers)})`)
      return Promise.resolve(false)
    }
  }

  blockFromPeer (conn: Object, newBlock: BcBlock) {
    const self = this
    // TODO: Validate new block mined by peer
    if (newBlock !== undefined && !self._knownBlocksCache.get(newBlock.getHash())) {
      self._logger.info('!!!!!!!!!! received new block from peer', newBlock.getHeight())
      debug(`Adding received block into cache of known blocks - ${newBlock.getHash()}`)
      // Add to cache
      this._knownBlocksCache.set(newBlock.getHash(), newBlock)

      const beforeBlockHighest = self.multiverse.getHighestBlock()
      const addedToMultiverse = self.multiverse.addBlock(newBlock)
      const afterBlockHighest = self.multiverse.getHighestBlock()

      // $FlowFixMe
      this._logger.debug('(' + self.multiverse._id + ') beforeBlockHighest: ' + beforeBlockHighest.getHash())
      // $FlowFixMe
      this._logger.debug('(' + self.multiverse._id + ') afterBlockHighest: ' + afterBlockHighest.getHash())
      // $FlowFixMe
      this._logger.debug('(' + self.multiverse._id + ') addedToMultiverse: ' + addedToMultiverse)

      if (addedToMultiverse === false) {
        this._logger.warn('(' + self.multiverse._id + ') !!!! Block failed to join multiverse')
        this._logger.warn('(' + self.multiverse._id + ') !!!!     height: ' + newBlock.getHeight())
        this._logger.warn('(' + self.multiverse._id + ') !!!!     hash: ' + newBlock.getHash())
        this._logger.warn('(' + self.multiverse._id + ') !!!!     previousHash: ' + newBlock.getPreviousHash())
        this._logger.warn('(' + self.multiverse._id + ') !!!!     distance: ' + newBlock.getDistance())
        this._logger.warn('(' + self.multiverse._id + ') !!!!     totalDistance: ' + newBlock.getTotalDistance())
      }
      if (beforeBlockHighest.getHash() !== afterBlockHighest.getHash()) {
        this.stopMining()
        this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock })
      } else if (afterBlockHighest.getHeight() < newBlock.getHeight() &&
        new BN(afterBlockHighest.getTotalDistance()).lt(new BN(newBlock.getTotalDistance())) === true) {
        self.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock, force: true })
        this.stopMining()
        const newMultiverse = new Multiverse()
        conn.getPeerInfo((err, peerInfo) => {
          if (err) {
            console.trace(err)
            self._logger.error(err)
            return false
          }
          const peerQuery = {
            queryHash: newBlock.getHash(),
            queryHeight: newBlock.getHeight(),
            low: Math.max(newBlock.getHeight() - 7, 1),
            high: newBlock.getHeight() - 1
          }
          debug('Querying peer for blocks', peerQuery)
          console.log('***********************CANDIDATE 0*******************')
          self.node.manager.createPeer(peerInfo)
            .query(peerQuery)
            .then((blocks) => {
              self._logger.info('peer sent ' + blocks.length + ' block multiverse ')
              debug('Got query response', blocks)
              const decOrder = blocks.sort((a, b) => {
                if (a.getHeight() > b.getHeight()) {
                  return -1
                }
                if (a.getHeight() < b.getHeight()) {
                  return 1
                }
                return 0
              })
              while (decOrder.length > 0) {
                newMultiverse.addBlock(decOrder.pop())
              }
              newMultiverse.addBlock(newBlock)
              if (Object.keys(newMultiverse).length > 6) {
                const highCandidateBlock = newMultiverse.getHighestBlock()
                const lowCandidateBlock = newMultiverse.getLowestBlock()
                if (new BN(highCandidateBlock.getTotalDistance()).gt(new BN(afterBlockHighest.getTotalDistance())) &&
                    highCandidateBlock.getHeight() >= afterBlockHighest.getHeight()) {
                  self.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock, force: true, multiverse: decOrder })
                  self.multiverse = newMultiverse
                  self._logger.info('applied new multiverse ' + newMultiverse.getHighestBlock().getHash())
                  self.blockpool._checkpoint = lowCandidateBlock
                  // sets multiverse for removal
                }
              }
            })
            .catch((err) => {
              console.trace(err)
            })
        })
      } else {

      }
    } else {
      console.log(`Received block is already in cache of known blocks - ${newBlock.getHash()}`)
      debug(`Received block is already in cache of known blocks - ${newBlock.getHash()}`)
    }
  }

  receiveSyncPeriod (peerIsSyncing: bool) {
    this._peerIsSyncing = peerIsSyncing
  }

  _cleanUnfinishedBlock () {
    debug('Cleaning unfinished block')
    this._unfinishedBlock = undefined
    this._unfinishedBlockData = undefined
  }

  _handleWorkerFinishedMessage (solution: { distance: number, nonce : string, difficulty: number, timestamp: number, iterations: number, timeDiff: number }) {
    const self = this
    if (this._unfinishedBlock === undefined || this._unfinishedBlock === null) {
      this._logger.warn('There is not an unfinished block to use solution for')
      return
    }

    const { nonce, distance, timestamp, difficulty, iterations, timeDiff } = solution

    // $FlowFixMe
    this._unfinishedBlock.setNonce(nonce)
    // $FlowFixMe
    this._unfinishedBlock.setDistance(distance)
    // $FlowFixMe
    this._unfinishedBlock.setTotalDistance(new BN(this._unfinishedBlock.getTotalDistance()).add(new BN(distance)).toString())
    // $FlowFixMe
    this._unfinishedBlock.setTimestamp(timestamp)
    // $FlowFixMe
    this._unfinishedBlock.setDifficulty(difficulty)

    if (this._unfinishedBlockData) {
      this._unfinishedBlockData.iterations = iterations
      this._unfinishedBlockData.timeDiff = timeDiff
    }

    if (!isValidBlock(this._unfinishedBlock)) {
      this._logger.warn(`The mined block is not valid`)
      this._cleanUnfinishedBlock()
      return
    }

    if (this._unfinishedBlock !== undefined && isDebugEnabled()) {
      this._writeMiningData(this._unfinishedBlock, solution)
    }

    this._processMinedBlock(this._unfinishedBlock, solution)
      .then((res) => {
        // If block was successfully processed then _cleanUnfinishedBlock
        if (res === true) {
          try {
            self._broadcastMinedBlock(self._unfinishedBlock, solution)
              .then((res) => {
                self._logger.info('block solution has been transmitted to network')
                self._cleanUnfinishedBlock()
              })
              .catch((err) => {
                self._logger.error(err)
                self._cleanUnfinishedBlock()
              })
          } catch (err) {
            self._cleanUnfinishedBlock()
          }
        }
      })
  }

  _handleWorkerError (error: Error) {
    this._logger.warn(`Mining worker process errored, reason: ${error.message}`)
    this._cleanUnfinishedBlock()
    // $FlowFixMe - Flow can't properly type subprocess
    if (this._workerProcess !== undefined && this._workerProcess !== null && this._workerProcess !== false) {
      try {
        // $FlowFixMe - Flow can't properly type subprocess
        this._workerProcess.disconnect()
        // $FlowFixMe - Flow can't properly type subprocess
        this._workerProcess.kill()
      } catch (_) {
        this._logger.warn(`Disconnecting or killing of miner process error - just cleaning up`)
        this._workerProcess = undefined
      }
      this._workerProcess = undefined
    }
  }

  _handleWorkerExit (code: number, signal: string) {
    if (code === 0 || code === null) { // 0 means worker exited on it's own correctly, null that is was terminated from engine
      this._logger.debug(`Mining worker finished its work (code: ${code})`)
    } else {
      this._logger.warn(`Mining worker process exited with code ${code}, signal ${signal}`)
      this._cleanUnfinishedBlock()
    }
    this._workerProcess = undefined
  }

  /**
   * Start Server
   *
   * @param opts Options to start server with
   */
  startServer (opts: Object) {
    this.server.run(opts)
  }

  requestExit () {
    ts.stop()
    return this._rovers.killRovers()
  }

  _writeRoverData (newBlock: BcBlock) {
    const dataPath = ensureDebugPath(`bc/rover-block-data.csv`)
    const rawData = JSON.stringify(newBlock)
    writeFileSync(dataPath, `${rawData}\r\n`, { encoding: 'utf8', flag: 'a' })
  }

  _writeMiningData (newBlock: BcBlock, solution: { iterations: number, timeDiff: number }) {
    // block_height, block_difficulty, block_distance, block_total_distance, block_timestamp, iterations_count, mining_duration_ms, btc_confirmation_count, btc_current_timestamp, eth_confirmation_count, eth_current_timestamp, lsk_confirmation_count, lsk_current_timestamp, neo_confirmation_count, neo_current_timestamp, wav_confirmation_count, wav_current_timestamp
    const row = [
      newBlock.getHeight(), newBlock.getDifficulty(), newBlock.getDistance(), newBlock.getTotalDistance(), newBlock.getTimestamp(), solution.iterations, solution.timeDiff
    ]

    this._knownRovers.forEach(roverName => {
      if (this._unfinishedBlockData && this._unfinishedBlockData.currentBlocks) {
        const methodNameGet = `get${roverName[0].toUpperCase() + roverName.slice(1)}List` // e.g. getBtcList
        // $FlowFixMe - flow does not now about methods of protobuf message instances
        const blocks = this._unfinishedBlockData.currentBlocks[methodNameGet]()
        row.push(blocks.map(block => block.getBlockchainConfirmationsInParentCount()).join('|'))
        row.push(blocks.map(block => block.getTimestamp() / 1000 << 0).join('|'))
      }
    })
    row.push(getBlockchainsBlocksCount(newBlock))
    const dataPath = ensureDebugPath(`bc/mining-data.csv`)
    writeFileSync(dataPath, `${row.join(',')}\r\n`, { encoding: 'utf8', flag: 'a' })
  }

  /**
   * Broadcast new block
   *
   * - peers
   * - pubsub
   * - ws
   *
   * This function is called by this._processMinedBlock()
   * @param newBlock
   * @param solution
   * @returns {Promise<boolean>}
   * @private
   */
  _broadcastMinedBlock (newBlock: BcBlock, solution: Object): Promise<*> {
    const self = this
    this._logger.info('Broadcasting mined block')

    if (newBlock === undefined) {
      return Promise.reject(new Error('cannot broadcast empty block'))
    }
    // if (Object.keys(self.multiverse).length > 6) {
    // }
    try {
      self.node.broadcastNewBlock(newBlock)
      try {
        const newBlockObj = {
          ...newBlock.toObject(),
          iterations: solution.iterations,
          timeDiff: solution.timeDiff
        }
        self.pubsub.publish('update.block.latest', { key: 'bc.block.' + newBlock.getHeight(), data: newBlock })
        self.pubsub.publish('block.mined', { type: 'block.mined', data: newBlockObj })
      } catch (e) {
        return Promise.reject(e)
      }
    } catch (err) {
      return Promise.reject(err)
    }
    return Promise.resolve(true)
  }

  /**
   * Deals with unfinished block after the solution is found
   *
   * @param newBlock
   * @param solution
   * @returns {Promise<boolean>} Promise indicating if the block was successfully processed
   * @private
   */
  _processMinedBlock (newBlock: BcBlock, solution: Object): Promise<*> {
    // TODO: reenable this._logger.info(`Mined new block: ${JSON.stringify(newBlockObj, null, 2)}`)

    // Trying to process null/undefined block
    if (newBlock === null || newBlock === undefined) {
      this._logger.warn('Failed to process work provided by miner')
      return Promise.resolve(false)
    }

    try {
      // Received block which is already in cache
      if (this._knownBlocksCache.has(newBlock.getHash())) {
        this._logger.warn('Recieved duplicate new block ' + newBlock.getHeight() + ' (' + newBlock.getHash() + ')')
        return Promise.resolve(false)
      }

      // Add to multiverse and call persist
      this._knownBlocksCache.set(newBlock.getHash(), newBlock)

      const beforeBlockHighest = this.multiverse.getHighestBlock()
      const addedToMultiverse = this.multiverse.addBlock(newBlock)
      const afterBlockHighest = this.multiverse.getHighestBlock()

      console.log('beforeBlockHighest height -> ' + beforeBlockHighest.getHeight() + ' ' + beforeBlockHighest.getHash())
      console.log('afterBlockHighest height -> ' + afterBlockHighest.getHeight() + ' ' + afterBlockHighest.getHash())
      console.log('addedToMultiverse: ' + addedToMultiverse)

      if (beforeBlockHighest.getHash() !== afterBlockHighest.getHash()) {
        this.stopMining()
        this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock })
        return Promise.resolve(true)
      } else if (afterBlockHighest.getHeight() < newBlock.getHeight() &&
                new BN(afterBlockHighest.getTotalDistance()).lt(new BN(newBlock.getTotalDistance())) === true) {
        this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock })
        return Promise.resolve(true)
      } else {
        return Promise.resolve(false)
      }
    } catch (err) {
      this._logger.warn(`failed to process work provided by miner, err: ${errToString(err)}`)
      return Promise.resolve(false)
    }
  }

  async startMining (rovers: string[] = ROVERS, block: Block): Promise<*> {
    const self = this
    // if (block === undefined) {
    //  return Promise.reject(new Error('cannot start mining on empty block'))
    // }
    // debug('Starting mining', rovers || ROVERS, block.toObject())

    let currentBlocks
    let lastPreviousBlock

    // get latest block from each child blockchain
    try {
      const getKeys: string[] = ROVERS.map(chain => `${chain}.block.latest`)
      currentBlocks = await Promise.all(getKeys.map((key) => {
        return self.persistence.get(key).then(block => {
          this._logger.debug(`Got "${key}"`)
          return block
        })
      }))
      this._logger.info(`Loaded ${currentBlocks.length} blocks from persistence`)
      // get latest known BC block
      try {
        lastPreviousBlock = await self.persistence.get('bc.block.latest')
        self._logger.info(`Got last previous block (height: ${lastPreviousBlock.getHeight()}) from persistence`)
        self._logger.debug(`Preparing new block`)

        const currentTimestamp = ts.nowSeconds()
        if (this._unfinishedBlock !== undefined && getBlockchainsBlocksCount(this._unfinishedBlock) >= 6) {
          this._cleanUnfinishedBlock()
        }
        const [newBlock, finalTimestamp] = prepareNewBlock(
          currentTimestamp,
          lastPreviousBlock,
          currentBlocks,
          block,
          [], // TODO: Transactions added here for AT period
          self._minerKey,
          self._unfinishedBlock
        )
        const work = prepareWork(lastPreviousBlock.getHash(), newBlock.getBlockchainHeaders())
        newBlock.setTimestamp(finalTimestamp)
        self._unfinishedBlock = newBlock
        self._unfinishedBlockData = {
          lastPreviousBlock,
          currentBlocks: newBlock.getBlockchainHeaders(),
          block,
          iterations: undefined,
          timeDiff: undefined
        }

        // if blockchains block count === 5 we will create a block with 6 blockchain blocks (which gets bonus)
        // if it's more, do not restart mining and start with new ones
        if (this._workerProcess && this._unfinishedBlock) {
          this._logger.debug(`Restarting mining with a new rovered block`)
          return self.restartMining()
        }

        // if (!this._workerProcess) {
        this._logger.debug(`Starting miner process with work: "${work}", difficulty: ${newBlock.getDifficulty()}, ${JSON.stringify(this._collectedBlocks, null, 2)}`)
        const proc: ChildProcess = fork(MINER_WORKER_PATH)
        this._workerProcess = proc
        // } else {
        //   this._logger.debug(`Sending work to existing miner process (pid: ${this._workerProcess.pid}), work: "${work}", difficulty: ${newBlock.getDifficulty()}, ${JSON.stringify(this._collectedBlocks, null, 2)}`)
        // }
        if (self._workerProcess !== null) {
          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          self._workerProcess.on('message', this._handleWorkerFinishedMessage.bind(this))
          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          self._workerProcess.on('error', this._handleWorkerError.bind(this))
          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          self._workerProcess.on('exit', this._handleWorkerExit.bind(this))
          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          self._workerProcess.send({
            currentTimestamp,
            offset: ts.offset,
            work,
            minerKey: this._minerKey,
            merkleRoot: newBlock.getMerkleRoot(),
            difficulty: newBlock.getDifficulty(),
            difficultyData: {
              currentTimestamp,
              lastPreviousBlock: lastPreviousBlock.serializeBinary(),
              // $FlowFixMe
              newBlockHeaders: newBlock.getBlockchainHeaders().serializeBinary()
            }})
          // $FlowFixMe - Flow can't properly find worker pid
          return Promise.resolve(self._workerProcess.pid)
        }
      } catch (err) {
        console.trace(err)
        self._logger.warn(`Error while getting last previous BC block, reason: ${err.message}`)
        return Promise.reject(err)
      }
      return Promise.resolve(false)
    } catch (err) {
      self._logger.warn(`Error while getting current blocks, reason: ${err.message}`)
      return Promise.reject(err)
    }
  }

  stopMining (): bool {
    debug('Stopping mining')

    if (!this._workerProcess) {
      return false
    }

    try {
      if (this._workerProcess !== undefined && this._workerProcess !== null && this._workerProcess !== false) {
        this._workerProcess.disconnect()
        this._workerProcess.removeAllListeners()
        this._workerProcess.kill()
        this._workerProcess = null
      }
    } catch (err) {
      this._logger.debug(`Stopping mining failed, reason: ${err.message}`)
      return false
    }
    return true
  }

  restartMining (rovers: string[] = ROVERS): Promise<boolean> {
    debug('Restarting mining', rovers)

    this.stopMining()
    // if (this._rawBlock.length > 0) {
    //  return this.startMining(rovers || ROVERS, this._rawBlock.pop())
    //    .then(res => {
    //      return Promise.resolve(!res)
    //    })
    // } else {
    return Promise.resolve(true)
    // }
  }
}
