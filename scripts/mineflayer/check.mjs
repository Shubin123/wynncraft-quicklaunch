#!/usr/bin/env node
/**
 * Verify the locally installed Mineflayer protocol data without opening a
 * Minecraft connection. This project intentionally has no Wynncraft bot:
 * Wynncraft does not permit in-game bot accounts.
 */
import { createRequire } from 'node:module'

// Mineflayer is deliberately installed in its own package, so use that
// package boundary rather than making a duplicate root dependency.
const require = createRequire(new URL('../../mineflayer-wynn/package.json', import.meta.url))
const mineflayer = require('mineflayer')
const minecraftData = require('minecraft-data')

const targetVersion = process.argv[2] ?? '1.21.11'
const data = minecraftData(targetVersion)

if (!data?.version) {
  console.error(`Mineflayer's installed protocol data does not include Minecraft ${targetVersion}.`)
  process.exitCode = 1
} else if (typeof mineflayer.createBot !== 'function') {
  console.error('Mineflayer loaded but did not expose createBot; reinstall dependencies.')
  process.exitCode = 1
} else {
  console.log(`Mineflayer offline check passed for Minecraft ${data.version.minecraftVersion} (protocol ${data.version.version}).`)
  console.log('No server connection was opened. Do not use Mineflayer to join Wynncraft.')
}
