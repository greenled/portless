import { loadConfig } from '@portless/config'
import { setupReverseProxy } from './proxy'
import { setupGreenlock } from './greenlock'

export async function startProxy () {
  const config = await loadConfig()
  const { publicKeyId } = await setupGreenlock(config)
  await setupReverseProxy(config, publicKeyId)
}
