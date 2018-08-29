/* e
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type BcBlock from '../protos/core_pb'
const { equals, flatten } = require('ramda')
const { validateBlockSequence } = require('./validation')
const { standardId } = require('./helper')
const logging = require('../logger')
const BN = require('bn.js')
const COMMIT_MULTIVERSE_DEPTH = 7

export class Multiverse {
  _blocks: Object
  _commitDepth: number
  _writeQueue: BcBlock[]
  _height: number
  _created: number
  _selective: boolean
  _id: string
  _logger: Object

  constructor (selective: boolean = false, commitDepth: number = COMMIT_MULTIVERSE_DEPTH) {
    this._id = standardId()
    this._selective = selective
    this._blocks = {}
    this._writeQueue = []
    this._commitDepth = commitDepth
    this._logger = logging.getLogger(__filename)
    this._height = 0
    this._created = Math.floor(Date.now() * 0.001)
    if (selective === true) {
      this._logger.warn('selective multiverse created')
    }
  }

  get blocks (): Object {
    return this._blocks
  }

  get blocksCount (): number {
    const blocks = Object.keys(this._blocks)
    return blocks.length
  }

  getMissingBlocks (block: BcBlock): Object {
    if (block === undefined) {
      this._logger.error('no block submitted to evaluate')
      return false
    }
    const highestBlock = this.getHighestBlock()
    const height = block.getHeight()
    const hash = block.getHash()
    const previousHash = block.getPreviousHash()
    const distance = block.getTotalDistance()
    const template = {
      queryHash: hash,
      queryHeight: height,
      message: '',
      from: 0,
      to: 0
    }
    if (highestBlock !== null) {
      if (highestBlock.getHash() === hash) {
        template.message = 'blocks are the equal to each-other'
        return template
      } else if (highestBlock.getHeight() === height) {
        if (new BN(highestBlock.getTotalDistance()).lt(new BN(distance)) === true) {
          this.addBlock(block)
          template.message = 'purposed block will be the current height of the multiverse'
        }
      } else if (highestBlock.getHash() === previousHash) {
        this.addBlock(block)
        template.message = 'purposed block is next block'
      } else if (highestBlock.getHeight() + 2 < height) {
        template.from = highestBlock.getHeight() - 2
        template.to = height + 1
        template.message = 'purposed block is ahead and disconnected from multiverse'
      } else if (highestBlock.getHeight() > height && (highestBlock.getHeight() - height <= 7)) {
        this.addBlock(block)
        template.from = height - 10
        template.to = height + 1
        template.message = 'purposed block may be in a multiverse layer'
      } else if (highestBlock.getHeight() > height) {
        this.addBlock(block)
        template.from = height - 1
        template.to = this.getLowestBlock().getHeight() + 1 // Plus one so we can check with the multiverse if side chain
        template.message = 'purposed block far behnd multiverse'
      }
      return template
    } else {
      this.addBlock(block)
      template.message = 'no highest block has been selected for multiverse'
    }
    return template
  }

  validateMultiverse (mv: Object): boolean {
    if (Object.keys(mv).length < 3) {
      this._logger.error('threshold not met, comparison between multiverse structures after dimension depth of 3')
      return false
    }
    return true
  }

  isBestMultiverse (alt: Object): boolean {
    const current = this._blocks
    if (!this.validateMultiverse(alt)) {
      this._logger.warn('candidate multiverse is malformed')
      return false
    }
    if (Object.keys(current).length < 7) {
      this._logger.warn('current multiverse below suggested distance threshold')
    }
    // TODO: Switch to child chain comparisons
    return false
  }

  addBlock (block: BcBlock, force: boolean = false): boolean {
    // TODO @klob extract to helpers
    const getAllBlockchainHashes = (block: BcBlock) => {
      const headersObj = block.getBlockchainHeaders().toObject()
      return Object.keys(headersObj).reduce((acc, blockchainListKey) => {
        return acc.concat(headersObj[blockchainListKey].map(headerObj => headerObj.hash))
      }, [])
    }
    const self = this
    const height = block.getHeight()
    const childHeight = height + 1
    const parentHeight = height - 1
    const keyCount = Object.keys(this._blocks).length
    const blockHeaderHashes = getAllBlockchainHashes(block)
    let uniqueParentHeaders = false
    let hasParentHash = false
    let hasParentHeight = false
    let hasParent = false
    let hasChildHash = false
    let hasChildHeight = false
    let hasChild = false
    let uniqueChildHeaders = false
    let alreadyInMultiverse = false
    let added = false
    let syncing = false
    this._logger.info('new multiverse candidate for height ' + height + ' (' + block.getHash() + ')')
    if (keyCount < 7 && this._selective === false) {
      this._logger.info('node is attempting to sync, multiverse filtering disabled')
      syncing = true
      force = true
      // keyCount must be 2 to account for the genesis block and the next block
    } else if (keyCount < 1) {
      syncing = true
      force = true
    }
    // if (keyCount > 16) {
    //  // remove the oldest
    //  const orderedKeys = Object.keys(this._blocks).sort((a, b) => {
    //    if (a > b) { return 1 }
    //    if (a < b) { return -1 }
    //    return 0
    //  })
    //  this._blocks[orderedKeys[0]] = 1
    // }
    if (this._blocks[parentHeight] !== undefined) {
      hasParentHash = this._blocks[parentHeight].reduce((all, item, i) => {
        if (item.getHash() === block.getPreviousHash()) {
          console.log('(' + self._id + ') !!! block ' + item.getHash() + ' is PARENT of --> ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)
      hasParentHeight = this._blocks[parentHeight].reduce((all, item, i) => {
        if (item.getHeight() === (block.getHeight() - 1)) {
          console.log('(' + self._id + ') !!! block ' + item.getHeight() + '  is parent of block ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)
      const parentBlockHeaders = getAllBlockchainHashes(this._blocks[parentHeight][0])
      uniqueParentHeaders = !equals(parentBlockHeaders, blockHeaderHashes)
      hasParent = hasParentHash === true && hasParentHeight === true && uniqueParentHeaders === true
    }
    if (this._blocks[childHeight] !== undefined) {
      hasChildHash = this._blocks[childHeight].reduce((all, item, i) => {
        if (item.getPreviousHash() === block.getHash() && (item.getHeight() - 1) === block.getHeight()) {
          console.log('(' + self._id + ') !!! block ' + item.getHash() + ' <-- is CHILD of ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)
      hasChildHeight = this._blocks[childHeight].reduce((all, item, i) => {
        if ((item.getHeight() - 1) === block.getHeight()) {
          console.log('(' + self._id + ') !!! block ' + item.getHeight() + ' <-- is CHILD of ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)
      const childBlockHeaders = getAllBlockchainHashes(this._blocks[childHeight][0])
      uniqueChildHeaders = !equals(childBlockHeaders, blockHeaderHashes)
      hasChild = hasChildHash === true && hasChildHeight === true && uniqueChildHeaders === true
    }
    if (this._blocks[height] !== undefined) {
      alreadyInMultiverse = this._blocks[height].reduce((all, item) => {
        if (item.getHash() === block.getHash()) {
          all = true
        }
        return all
      }, false)
    }
    if (hasChild === false && hasParent === false) {
      const failures = {}
      failures['hasParentHash'] = hasParentHash
      failures['hasParentHeight'] = hasParentHeight
      failures['uniqueParentHeaders'] = uniqueParentHeaders
      failures['hasChildHash'] = hasChildHash
      failures['hasChildHeight'] = hasChildHeight
      failures['uniqueChildHeaders'] = uniqueChildHeaders
      this._logger.info(failures)
    }
    this._logger.info('Block hasParent: ' + hasParent + ' hasChild: ' + hasChild + ' syncing: ' + syncing + ' height: ' + height + ' alreadyInMultiverse: ' + alreadyInMultiverse)
    if (hasParent === true || hasChild === true) {
      if (alreadyInMultiverse === false) {
        if (self._blocks[height] === undefined) {
          self._blocks[height] = []
        }
        if (self._blocks[height][0] !== undefined && self._blocks[height][0].getHash() === block.getPreviousHash()) {
          self._blocks[height].push(block)
        } else {
          self._blocks[height].push(block)
        }
        if (self._blocks[height].length > 1) {
          self._blocks[height] = self._blocks[height].sort((a, b) => {
            if (new BN(a.getTotalDistance()).lt(new BN(b.getTotalDistance())) === true) return 1
            if (new BN(a.getTotalDistance()).gt(new BN(b.getTotalDistance())) === true) return -1
            return 0
          })
        }
        return true
      } else {
        this._logger.warn('block ' + block.getHash() + ' already in multiverse')
      }
    } else if (force === true || syncing === true) {
      if (self._blocks[height] === undefined) {
        self._blocks[height] = []
      }
      self._blocks[height].push(block)
      if (self._blocks[height].length > 1) {
        self._blocks[height] = self._blocks[height].sort((a, b) => {
          if (new BN(a.getTotalDistance()).lt(new BN(b.getTotalDistance())) === true) {
            return 1
          }
          if (new BN(a.getTotalDistance()).gt(new BN(b.getTotalDistance())) === true) {
            return -1
          }
          return 0
        })
      }
      added = true
      return added
    }
    return added
  }

  purge () {
    this._blocks = {}
    this._writeQueue = []
    this._logger.info('metaverse has been purged')
  }

  caseBetterMultiverse (block: BcBlock): ?BcBlock {
    const currentHighestBlock = this.getHighestBlock()
    this._logger.info(currentHighestBlock)
    // TODO: Stub function for the comparison of two multiverse structures
  }

  getHighestBlock (depth: ?number = 7, keys: string[] = [], list: ?Array<*>): ?BcBlock {
    /*
     *
     *           --X|---
     *           ---|-X-
     *           X--|---
     *
     *    dim([t,d]) . max(t+d*n)
     *
     */
    if (Object.keys(this._blocks).length === 0) {
      this._logger.warn('unable to determine height from incomplete multiverse')
      return false
    }
    if (keys.length === 0) {
      keys = Object.keys(this._blocks).sort((a, b) => {
        if (a > b) {
          return -1
        }
        if (a < b) {
          return 1
        }
        return 0
      })
      list = []
    }
    const currentHeight = keys.pop()
    const currentRow = this._blocks[currentHeight]
    let matches = []
    currentRow.map((candidate) => { // [option1, option2, option3]
      matches = list.reduce((all, chain) => {
        if (chain !== undefined && chain[0] !== undefined) {
          if (chain[0].getPreviousHash() === candidate.getHash()) {
            all++
            chain.unshift(candidate)
          }
        }
        return all
      }, 0)
      if (matches === 0) { // this must be it's own chain
        list.push([candidate])
      }
    })
    // Cycle through keys
    if (keys.length > 0) {
      return this.getHighestBlock(depth, keys, list)
    }
    const minimumDepthChains = list.reduce((all, chain) => {
      if (chain.length >= depth && validateBlockSequence(chain) === true) {
        all.push(chain)
      }
      return all
    }, [])
    if (minimumDepthChains === undefined) {
      // Any new block is the highest
      return true
    } else if (minimumDepthChains !== undefined && minimumDepthChains.length === 0) {
      const performance = list.reduce((order, chain) => {
        const totalDistance = chain.reduce((all, b) => {
          all = new BN(b.getTotalDistance()).add(new BN(all))
          return all
        }, 1)
        if (order.length === 0) {
          order.push([chain, totalDistance])
        } else if (order.length > 0 && order[0] !== undefined && order[0][1] < totalDistance) {
          order.unshift([chain, totalDistance])
        }
        return order
      }, [])
      const results = performance.sort((a, b) => {
        if (a[1] > b[1]) {
          return 1
        }
        if (a[1] < b[1]) {
          return -1
        }
        return 0
      }).reverse()
      return results[0][0].pop()
    } else if (minimumDepthChains !== undefined && minimumDepthChains.length === 1) {
      return minimumDepthChains[0][0]
    } else {
      const performance = minimumDepthChains.reduce((order, chain) => {
        const totalDistance = chain.reduce((all, b) => {
          all = new BN(b.getTotalDistance()).add(all)
          all.push(b)
        }, 1)
        if (order.length === 0) {
          order.push([chain, totalDistance])
        } else if (order.length > 0 && order[0] !== undefined && order[0][1] < totalDistance) {
          order.unshift([chain, totalDistance])
        }
        return order
      }, [])
      const results = performance.sort((a, b) => {
        if (a[1] < b[1]) {
          return 1
        }
        if (a[1] > b[1]) {
          return -1
        }
        return 0
      }).reverse()
      return results[0][0].pop()
    }
  }

  getLowestBlock (): ?BcBlock {
    const keys = Object.keys(this._blocks)
    if (keys.length > 0) {
      const last = keys.shift()
      const block = this._blocks[last][0]
      return block
    } else {
      return null
    }
  }

  shouldBroadcastBlock (block: BcBlock, force: boolean = false): boolean {
    const highestBlock = this.getHighestBlock()
    if (highestBlock !== null) {
      if (this.addBlock(block, force) === true) {
        // $FlowFixMe
        const height = highestBlock.getHeight()
        if (block.getHeight() >= height) {
          return true
        }
      }
      return true
    }
    return false
  }

  toArray (): Array<Array<BcBlock>> {
    return this._blocks.toarray()
  }

  toFlatArray (): Array<BcBlock> {
    const blocks = this.toArray()
    return flatten(blocks)
  }

  print () {
    // this._logger.info(this._blocks)
    console.log('multiverse print disabled')
  }
}

export default Multiverse
