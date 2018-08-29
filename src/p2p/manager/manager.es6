/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Bundle } from './../bundle'

const debug = require('debug')('bcnode:p2p:manager')
const { mergeDeepRight } = require('ramda')
const PeerInfo = require('peer-info')
const pull = require('pull-stream')

const { ManagedPeerBook } = require('../book/book')
const { toObject } = require('../../helper/debug')
const { Peer } = require('../peer')
const { PeerNode } = require('../node')
const { registerProtocols } = require('../protocol')
const logging = require('../../logger')

const { PROTOCOL_PREFIX } = require('../protocol/version')

const BC_P2P_PASSIVE = !!process.env.BC_P2P_PASSIVE

export const DATETIME_STARTED_AT = Date.now()

const { PEER_QUORUM_SIZE } = require('../quorum')

export class PeerManager {
  _logger: Object // eslint-disable-line no-undef
  _statsInterval: IntervalID // eslint-disable-line no-undef
  _peerBook: ManagedPeerBook // eslint-disable-line no-undef
  _peerBookConnected: ManagedPeerBook // eslint-disable-line no-undef
  _peerBookDiscovered: ManagedPeerBook // eslint-disable-line no-undef
  _peerNode: PeerNode // eslint-disable-line no-undef
  _lastQuorumSync: ?Date
  _quorumSyncing: boolean

  constructor (node: PeerNode) {
    debug('constructor()')
    const self = this
    this._logger = logging.getLogger(__filename)
    this._peerNode = node
    this._peerBook = new ManagedPeerBook(this, 'main')
    this._peerBookConnected = new ManagedPeerBook(this, 'connected')
    this._peerBookDiscovered = new ManagedPeerBook(this, 'discovered')
    this._lastQuorumSync = null
    this._quorumSyncing = false

    this._statsInterval = setInterval(() => {
      const stats = this.peerNode.bundle && this.peerNode.bundle.stats
      const peers = (stats && stats.peers()) || []
      if (peers.length < 1) {
        return
      }

      const data = peers.reduce((acc, el) => {
        const peerStats = stats.forPeer(el)
        if (peerStats) {
          acc[el] = {
            snapshot: {
              dataReceived: parseInt(peerStats.snapshot.dataReceived, 10),
              dataSent: parseInt(peerStats.snapshot.dataSent, 10)
            },
            avg: peerStats.movingAverages
          }
        }
        return acc
      }, {})

      if (this.engine.server) {
        this.engine.server._wsBroadcast({
          type: 'peer.stats',
          data
        })
      }
    }, 10 * 1000)

    //this.engine.pubsub.subscribe('update.block.latest', '<engine>', (block) => {
    //  self.engine.restartMiner(block)
    //})
    //this.pubsub.publish('block.mined', { type: 'block.mined', data: newBlockObj })

  }

  get bundle (): Bundle {
    return this._peerNode.bundle
  }

  get engine (): Object {
    return this.peerNode._engine
  }

  get peerBook (): ManagedPeerBook {
    return this._peerBook
  }

  get peerBookConnected (): ManagedPeerBook {
    return this._peerBookConnected
  }

  get peerBookDiscovered (): ManagedPeerBook {
    return this._peerBookDiscovered
  }

  get peerNode (): PeerNode {
    return this._peerNode
  }

  createPeer (peerId: PeerInfo): Peer {
    return new Peer(this.bundle, peerId)
  }

  isQuorumSynced (): boolean {
    // TODO: Fix  
    return this._quorumSyncing === false 
    //return false 
  }

  onPeerDiscovery (peer: PeerInfo) {
    const peerId = peer.id.toB58String()
    debug('Event - peer:discovery', peerId)

    if (!this.peerBookDiscovered.has(peer)) {
      // TODO: Meta info ???
      this.peerBookDiscovered.put(peer)
      debug(`Adding newly discovered peer '${peerId}' to discoveredPeerBook, count: ${this.peerBookDiscovered.getPeersCount()}`)
    } else {
      debug(`Discovered peer ${peerId} already in discoveredPeerBook`)
      return
    }

    if (!BC_P2P_PASSIVE && !this.peerBookConnected.has(peer)) {
      debug(`Dialing newly discovered peer ${peerId}`)
      return this.bundle.dial(peer, (err) => {
        if (err) {
          const errMsg = `Dialing discovered peer '${peerId}' failed, reason: '${err.message}' - peer will be redialed`
          debug(errMsg)
          this._logger.debug(errMsg)

          // Throwing error is not needed, peer will be dialed once circuit is enabled
          // this.peerBookDiscovered.remove(peer)

          return
        }

        this._logger.info(`Discovered peer successfully dialed ${peerId}`)
      })
    }
  }

  onPeerConnect (peer: PeerInfo) {
    const peerId = peer.id.toB58String()
    debug('Event - peer:connect', peerId)

    if (!this.peerBookConnected.has(peer)) {
      this.peerBookConnected.put(peer)
      debug(`Connected new peer '${peerId}', adding to connectedPeerBook, count: ${this.peerBookConnected.getPeersCount()}`)

      if (!this._lastQuorumSync && this.peerBookConnected.getPeersCount() >= PEER_QUORUM_SIZE) {
        this._quorumSyncing = true
        this._lastQuorumSync = new Date()

        this.peerNode.triggerBlockSync()
      }

    } else {
      debug(`Peer '${peerId}', already in connectedPeerBook`)
      return
    }

    this.createPeer(peer)
      .getLatestHeader()
      .then((header) => {
        debug('Peer latest header', peer.id.toB58String(), toObject(header))
      })

    this._checkPeerStatus(peer)
  }

  onPeerDisconnect (peer: PeerInfo) {
    const peerId = peer.id.toB58String()
    debug('Event - peer:disconnect', peerId)

    if (this.peerBookConnected.has(peer)) {
      this.peerBookConnected.remove(peer)
      this.engine._emitter.emit('peerDisconnected', { peer })

      debug(`Peer disconnected '${peerId}', removing from connectedPeerBook, count: ${this.peerBookConnected.getPeersCount()}`)
    } else {
      debug(`Peer '${peerId}', already removed from connectedPeerBook`)
    }

    if (this._peerBookDiscovered.has(peer)) {
      this._peerBookDiscovered.remove(peer)
    }
  }

  registerProtocols (bundle: Bundle) {
    registerProtocols(this, bundle)
  }

  _checkPeerStatus (peer: PeerInfo) {
    const peerId = peer.id.toB58String()
    debug('Checking peer status', peerId)

    const meta = {
      ts: {
        connectedAt: Date.now()
      }
    }

    debug('Dialing /status protocol', peerId)
    this.bundle.dialProtocol(peer, `${PROTOCOL_PREFIX}/status`, (err, conn) => {
      const peerId = peer.id.toB58String()

      if (err) {
        debug('Error dialing /status protocol', peerId, err)
        this._logger.error('Error dialing /status protocol', peerId)

        // FIXME: Propagate corectly
        // throw err

        return
      }

      debug('Pulling latest /status', peerId)
      pull(
        conn,
        pull.collect((err, wireData) => {
          if (err) {
            debug('Error pulling latest /status', peerId, err)

            // FIXME: Propagate corectly
            // throw err

            return
          }

          debug('Getting latest peer info', peerId)
          conn.getPeerInfo((err, peerInfo) => {
            if (err) {
              debug('Error getting latest peer info', peerId, err)

              // FIXME: Propagate corectly
              // throw err

              return
            }

            if (this.peerBookConnected.has(peer)) {
              debug('Updating peer with meta/status', peerId)
              const existingPeer = this.peerBookConnected.get(peer)

              const status = JSON.parse(wireData[0])
              existingPeer.meta = mergeDeepRight(meta, status)
            } else {
              debug('Unable to update peer meta/status, not in peerBookConnected', peerId)
            }

            this.engine._emitter.emit('peerConnected', { peer })
          })
        })
      )
    })
  }
}
