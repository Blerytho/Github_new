/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type PeerInfo from 'peer-info'
import type { Bundle } from './../bundle'

const { inspect } = require('util')
const debug = require('debug')('bcnode:peer:peer')
const pull = require('pull-stream')
const { BcBlock } = require('../../protos/core_pb')
const { isValidBlock, validateBlockSequence } = require('../../bc/validation')

const { PROTOCOL_PREFIX } = require('../protocol/version')

export type HeaderIdentifier = [number, string] // height, hash

export class Peer {
  _bundle: Bundle
  _peerId: PeerInfo

  constructor (bundle: Bundle, peerId: PeerInfo) {
    this._bundle = bundle
    this._peerId = peerId
  }

  get bundle (): Bundle {
    return this._bundle
  }

  get peerId (): PeerInfo {
    return this._peerId
  }

  getHeaders (from: HeaderIdentifier, to: HeaderIdentifier): Promise<*> {
    debug(`getHeaders(${from.toString()}, ${to.toString()})`, this.peerId.id.toB58String())

    return new Promise((resolve, reject) => {
      this.bundle.dialProtocol(this.peerId, `${PROTOCOL_PREFIX}/rpc`, (err, conn) => {
        if (err) {
          return reject(err)
        }

        const msg = {
          jsonrpc: '2.0',
          method: 'getHeaders',
          params: [from, to],
          id: 42
        }

        pull(pull.values([JSON.stringify(msg)]), conn)

        pull(
          conn,
          pull.collect((err, wireData) => {
            if (err) {
              return reject(err)
            }

            try {
              const blocks = wireData.map(b => BcBlock.deserializeBinary(Uint8Array.from(b).buffer))
              // validate each block separately
              blocks.forEach(block => {
                if (!isValidBlock()) {
                  const reason = `Block ${block.getHeight()}, h: ${block.getHash()} is not a valid BC block`
                  debug(reason)
                  reject(new Error(reason))
                }
              })
              // validate that the block sequence is valid
              if (!validateBlockSequence(blocks)) {
                const reason = `Block sequence not valid`
                debug(reason)
                reject(new Error(reason))
              }
              resolve(blocks)
            } catch (e) {
              return reject(e)
            }
          })
        )
      })
    })
  }

  getLatestHeader (): Promise<*> {
    debug('getLatestHeader()', this.peerId.id.toB58String())

    return new Promise((resolve, reject) => {
      this.bundle.dialProtocol(this.peerId, `${PROTOCOL_PREFIX}/rpc`, (err, conn) => {
        if (err) {
          return reject(err)
        }

        const msg = {
          jsonrpc: '2.0',
          method: 'getLatestHeader',
          params: [],
          id: 42
        }

        pull(pull.values([JSON.stringify(msg)]), conn)

        pull(
          conn,
          pull.collect((err, wireData) => {
            if (err) {
              return reject(err)
            }

            try {
              const result = BcBlock.deserializeBinary(Uint8Array.from(wireData[0]).buffer)
              resolve(result)
            } catch (e) {
              return reject(e)
            }
          })
        )
      })
    })
  }

  getLatestHeaders (count: number = 10): Promise<*> {
    debug(`getLatestHeaders(${count})`, this.peerId.id.toB58String())

    return new Promise((resolve, reject) => {
      this.bundle.dialProtocol(this.peerId, `${PROTOCOL_PREFIX}/rpc`, (err, conn) => {
        if (err) {
          return reject(err)
        }

        const msg = {
          jsonrpc: '2.0',
          method: 'getLatestHeaders',
          params: [count],
          id: 42
        }

        pull(pull.values([JSON.stringify(msg)]), conn)

        pull(
          conn,
          pull.collect((err, wireData) => {
            if (err) {
              return reject(err)
            }

            try {
              const result = wireData.map(b => BcBlock.deserializeBinary(Uint8Array.from(b).buffer))
              resolve(result)
            } catch (e) {
              return reject(e)
            }
          })
        )
      })
    })
  }

  getMultiverse (): Promise<*> {
    debug(`getMultiverse()`, this.peerId.id.toB58String())

    return new Promise((resolve, reject) => {
      this.bundle.dialProtocol(this.peerId, `${PROTOCOL_PREFIX}/rpc`, (err, conn) => {
        if (err) {
          return reject(err)
        }

        const msg = {
          jsonrpc: '2.0',
          method: 'getMultiverse',
          params: [],
          id: 42
        }

        pull(pull.values([JSON.stringify(msg)]), conn)

        pull(
          conn,
          pull.collect((err, wireData) => {
            if (err) {
              return reject(err)
            }

            try {
              const result = wireData.map(b => BcBlock.deserializeBinary(Uint8Array.from(b).buffer))
              resolve(result)
            } catch (e) {
              return reject(e)
            }
          })
        )
      })
    })
  }

  query (params: Object = {}): Promise<*> {
    debug(`query(${inspect(params)})`, this.peerId.id.toB58String())

    return new Promise((resolve, reject) => {
      this.bundle.dialProtocol(this.peerId, `${PROTOCOL_PREFIX}/rpc`, (err, conn) => {
        if (err) {
          return reject(err)
        }

        const msg = {
          jsonrpc: '2.0',
          method: 'query',
          params: [params],
          id: 42
        }

        pull(pull.values([JSON.stringify(msg)]), conn)

        pull(
          conn,
          pull.collect((err, wireData) => {
            if (err) {
              return reject(err)
            }

            try {
              const result = wireData.map(b => BcBlock.deserializeBinary(Uint8Array.from(b).buffer))
              resolve(result)
            } catch (e) {
              return reject(e)
            }
          })
        )
      })
    })
  }
}

export default Peer
