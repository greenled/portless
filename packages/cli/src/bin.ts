#!/usr/bin/env node

import cac from 'cac'
import { startDaemon, stopDaemon } from './daemon'
import { addApp, removeApp, restartApp } from './app'

const cli = cac()

cli.command('start', 'Start Deamon')
  .action(async () => {
    await startDaemon()
  })

cli.command('stop', 'Stop Deamon')
  .action(async () => {
    await stopDaemon()
  })

cli.command('add', 'Add project in current folder')
  .action(async () => {
    await addApp(process.cwd())
  })

cli.command('remove', 'Remove project in current folder')
  .action(async () => {
    await removeApp(process.cwd())
  })

cli.command('restart', 'Restart project in current folder')
  .action(async () => {
    await restartApp(process.cwd())
  })

cli.help()
cli.version(require('../package.json').version)
cli.parse()
