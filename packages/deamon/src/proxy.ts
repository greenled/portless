import http, { IncomingMessage } from 'http'
import httpProxy from 'http-proxy'
import PacProxyAgent from 'pac-proxy-agent'
import consola from 'consola'
import chalk from 'chalk'
import path from 'path'
import { renderTemplate } from '@portless/template'
import { PortlessConfig, ProxyRedirectConfig } from '@portless/config'
import { escapeReg, getDomain, ThenType } from '@portless/util'

const acmeChallengePath = '/.well-known/acme-challenge/'

export interface ReverseProxyOptions {
  publicKeyId?: string
}

export type PublicUrlCallback = (targetUrl: string, publicUrl: string) => void

export async function useReverseProxy (config: PortlessConfig, options: ReverseProxyOptions = {}) {
  if (!config.reverseProxy) return null

  const pacProxyAgent = config.targetProxy ? new PacProxyAgent(config.targetProxy) : undefined

  const publicUrlCallbacks: PublicUrlCallback[] = []

  function onPublicUrl (cb: PublicUrlCallback) {
    publicUrlCallbacks.push(cb)
  }

  const servers: http.Server[] = []

  async function proxyTarget (redirect: ProxyRedirectConfig) {
    const { port, target } = redirect

    const proxyUrl = `0.0.0.0:${port}`

    const domain = config.domains ? config.domains.find(d => d.targetUrl === target) : undefined

    const proxy = httpProxy.createProxyServer({
      target,
      agent: pacProxyAgent,
      changeOrigin: true,
      secure: false,
      cookieDomainRewrite: {
        // Remove cookie domains
        '*': '',
      },
      ws: true,
    })

    proxy.on('error', (err, req, res) => {
      res.writeHead(500, {
        ContentType: 'text/html; charset=utf-8',
      })
      let errorMessage = err.message
      if (errorMessage.startsWith('getaddrinfo ENOTFOUND')) {
        errorMessage = `Can't find host <b>${errorMessage.substr('getaddrinfo ENOTFOUND'.length + 1)}</b>`
      }

      res.end(renderTemplate(path.resolve(__dirname, '../templates/error.ejs'), {
        errorMessage,
        errorStack: err.stack,
      }))
      consola.error(err.stack)
    })

    // Rewrite URL in responses
    let replaceReg: RegExp
    let replaceMap: { [key: string]: string }
    let replaceFunc: (matched: string) => string
    let reverseReplaceReg: RegExp
    let reverseReplaceMap: { [key: string]: string }
    let reverseReplaceFunc: (matched: string) => string
    if (config.domains) {
      replaceMap = {}
      reverseReplaceMap = {}
      const escapedUrls: string[] = []
      const reverseEcapedUrls: string[] = []
      for (const domainConfig of config.domains) {
        const targetDomain = getDomain(domainConfig.targetUrl)
        if (domainConfig.publicUrl) {
          const publicDomain = getDomain(domainConfig.publicUrl)
          replaceMap[targetDomain] = publicDomain
          escapedUrls.push(escapeReg(targetDomain))
          reverseReplaceMap[publicDomain] = targetDomain
          reverseEcapedUrls.push(escapeReg(publicDomain))
        }
      }
      replaceReg = new RegExp(`(${escapedUrls.join('|')})`, 'g')
      replaceFunc = (matched: string) => replaceMap[matched]
      reverseReplaceReg = new RegExp(`(${reverseEcapedUrls.join('|')})`, 'g')
      reverseReplaceFunc = (matched: string) => reverseReplaceMap[matched]
    }

    const server = http.createServer((req, res) => {
      // Acme challenge to issue certificates
      if (options.publicKeyId) {
        if (req.url && req.url.startsWith(acmeChallengePath)) {
          const id = req.url.substr(acmeChallengePath.length)
          res.write(`${id}.${options.publicKeyId}`)
          res.end()
          return
        }
      }

      if (replaceReg) {
        let shouldRewrite = false

        // Rewrite links
        const _writeHead = res.writeHead.bind(res)
        res.writeHead = (...args: any) => {
          const headers = (args.length > 2) ? args[2] : args[1]

          // Check content type to enable rewriting
          const contentType = res.getHeader('content-type') || (headers ? headers['content-type'] : undefined)
          shouldRewrite = contentType && [
            'text/html',
            'text/css',
            'application/javascript',
          ].some(type => contentType.includes(type))

          if (shouldRewrite) {
            // Remove content-length heander since it will change
            res.removeHeader('content-length')
            if (headers) {
              delete headers['content-length']
            }
          }

          // Replace CORS header
          const corsHeader = res.getHeader('access-control-allow-origin')
          if (corsHeader && typeof corsHeader === 'string') {
            res.setHeader('access-control-allow-origin', corsHeader.replace(replaceReg, replaceFunc))
          }
          if (headers && headers['access-control-allow-origin']) {
            headers['access-control-allow-origin'] = headers['access-control-allow-origin'].replace(replaceReg, replaceFunc)
          }

          return _writeHead(...args)
        }

        const _write = res.write.bind(res)
        res.write = (data: string | Buffer) => {
          if (shouldRewrite) {
            let text: string
            if (data instanceof Buffer) {
              text = data.toString()
            } else {
              text = data
            }
            const newText = text.replace(replaceReg, replaceFunc)
            return _write(newText)
          } else {
            return _write(data)
          }
        }

        const _end = res.end.bind(res)
        res.end = () => {
          _end()
        }
      }

      // Proxy HTTP
      proxy.web(req, res)
    })

    server.on('upgrade', (req: IncomingMessage, socket, head) => {
      if (req.headers.host) {
        req.headers.host = req.headers.host.replace(reverseReplaceReg, reverseReplaceFunc)
      }
      if (Array.isArray(req.headers.origin)) {
        req.headers.origin = req.headers.origin.map(value => value.replace(reverseReplaceReg, reverseReplaceFunc))
      } else if (req.headers.origin) {
        req.headers.origin = req.headers.origin.replace(reverseReplaceReg, reverseReplaceFunc)
      }

      // Proxy websockets
      proxy.ws(req, socket, head)
    })

    server.listen(port, '0.0.0.0', () => {
      consola.success(chalk.blue('Proxy'), proxyUrl, '=>', target)

      if (domain && domain.publicUrl !== undefined) {
        publicUrlCallbacks.forEach(cb => cb(proxyUrl, domain.publicUrl as string))
      }
    })

    servers.push(server)
  }

  for (const redirect of config.reverseProxy.redirects) {
    await proxyTarget(redirect)
  }

  function destroy () {
    for (const server of servers) {
      server.close()
    }
  }

  return {
    onPublicUrl,
    destroy,
  }
}

export type UseReverseProxy = ThenType<typeof useReverseProxy>