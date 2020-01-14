import Greenlock from 'greenlock'
import consola from 'consola'
import chalk from 'chalk'
import fs from 'fs-extra'
import path from 'path'
import { PortlessConfig } from '@portless/config'
import { getDomain, getRcFolder, wait } from '@portless/util'
import { restartNgrokTunnels } from './ngrok'

export interface GreenlockInfo {
  publicKeyId?: string
}

export async function setupGreenlock (config: PortlessConfig): Promise<GreenlockInfo> {
  const options = config.greenlock
  if (!options) return {}

  let publicDomains: string[]
  if (config.domains) {
    publicDomains = config.domains
      .filter(domainConfig => !!domainConfig.publicUrl)
      // @ts-ignore
      .map(domainConfig => getDomain(domainConfig.publicUrl))
  } else {
    consola.warn('No public domains defined.')
    return {}
  }

  const configDir = getRcFolder('greenlock-config')
  const packageRoot = getRcFolder('greenlock')

  const site = {
    subject: publicDomains[0],
    altnames: publicDomains,
  }

  const greenlock = Greenlock.create({
    configDir,
    packageRoot,
    packageAgent: options.packageAgent,
    maintainerEmail: options.maintainerEmail,
    staging: options.staging,
    notify: (event: string, details: any) => {
      if (event === 'error') {
        consola.error(details)
      } else if (event === 'warning') {
        consola.warn(details)
      } else if (event === 'certificate_order') {
        consola.info('Ordering certificate...', details.subject, details.altnames)
      } else if (event === 'challenge_select') {
        consola.info('Challenging', details.altname)
      } else if (event === 'challenge_status') {
        if (details.status === 'pending') {
          consola.info('Challenge pending', details.altname)
        } else if (details.status === 'valid') {
          consola.success(chalk.green('Challenge valid'), details.altname)
        } else {
          consola.info('Challenge status', details)
        }
      } else if (event === 'certificate_status') {
        if (details.status === 'valid') {
          consola.success(chalk.green('Certificate valid'), details.subject)
        } else {
          consola.info('Challenge status', details)
        }
      } else if (event === 'cert_issue') {
        consola.success(chalk.green('Certificate issued'), details)
        restartNgrokTunnels()
      } else {
        consola.info(chalk.blue(event), details)
      }
    },
  })

  await greenlock.manager.defaults({
    subscriberEmail: options.maintainerEmail,
    agreeToTerms: true,
    directoryUrl: options.staging ? 'https://acme-staging-v02.api.letsencrypt.org/directory' : 'https://acme-v02.api.letsencrypt.org/directory',
  })

  await greenlock.add(site)

  const accountFile = path.resolve(configDir, `accounts/acme${options.staging ? '-staging' : ''}-v02.api.letsencrypt.org/directory`, `${options.maintainerEmail}.json`)

  async function readAccountData (): Promise<any> {
    if (fs.existsSync(accountFile)) {
      return fs.readJson(accountFile)
    } else {
      await wait(500)
      return readAccountData()
    }
  }
  const accountData = await readAccountData()
  const publicKeyId = accountData.publicKeyJwk.kid

  return {
    publicKeyId,
  }
}
