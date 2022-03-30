import compose from 'koa-compose'
import pathMatch from "path-match";
import Agent from 'agentkeepalive'
import httpProxy from 'http-proxy';
import safeStringify from 'fast-safe-stringify'
import koaCash from '../lib/koaCache.js';

const { createProxyServer } = httpProxy;

const CACHED_REQUESTS = {
  'cosmos/staking/v1beta1/validators': 5 * 60,
  'cosmos/authz/v1beta1/grants': 1 * 60
}

const ProxyController = (client, registry) => {
  const proxy = createProxyServer()

  proxy.on('proxyRes', (proxyRes, req, res) => {
    var body = [];
    proxyRes.on('data', function (chunk) {
      body.push(chunk);
    });

    proxyRes.on('end', function () {
      res.rawBody = Buffer.concat(body).toString()
    });
  })

  proxy.on('error', (err, req, res) => {
    res.writeHead(500, {
      'Content-Type': 'text/plain'
    });
    res.end('Something went wrong: ' + err.message);
  })

  const httpAgent = new Agent();
  const httpsAgent = new Agent.HttpsAgent();

  const route = pathMatch({
    sensitive: false,
    strict: false,
    end: false
  })

  function routes(type){
    return compose([
      getChain(type),
      initCache(),
      serveCache,
      proxyRequest
    ])
  }

  function getChain(type){
    return async (ctx, next) => {
      const match = route('/:chain')
      const params = match(ctx.path)
      const chainName = params?.chain
      const chain = chainName && await registry.getChain(chainName)
      const url = chain && await chain.apis.bestAddress(type)
      if (!chain) {
        ctx.res.writeHead(404, {
          'Content-Type': 'text/plain'
        });
        return ctx.res.end('Chain not found');
      } else if (!url) {
        ctx.res.writeHead(502, {
          'Content-Type': 'text/plain'
        });
        return ctx.res.end('No servers available');
      }
      ctx.state.chainName = chainName
      ctx.state.proxyUrl = url
      return next()
    }
  }

  function initCache(){
    return koaCash({
      maxAge: 60,
      setCachedHeader: true,
      compression: true,
      async get(key) {
        let value;
        try {
          value = await client.get('cache:'+key);
          if (value) value = JSON.parse(value);
        } catch (err) {
          console.error(err);
        }

        return value;
      },
      set(key, value, maxAge) {
        if (maxAge <= 0) return client.setEx('cache:'+key, 60, safeStringify(value));
        return client.setEx('cache:'+key, maxAge, safeStringify(value));
      }
    })
  }

  async function serveCache(ctx, next){
    let { path } = ctx.request;
    path = path.split('/').slice(2).join('/')
    if(CACHED_REQUESTS.hasOwnProperty(path)){
      const maxAge = CACHED_REQUESTS[path]
      if (await ctx.cashed(maxAge)) return
    }
    return next()
  }

  async function proxyRequest(ctx, next){
    const chainName = ctx.state.chainName
    if (!chainName) return next()

    const url = new URL(ctx.state.proxyUrl)

    return new Promise((resolve) => {
      const opts = {
        target: ctx.state.proxyUrl,
        changeOrigin: true,
        proxyTimeout: 30 * 1000,
        timeout: 30 * 1000,
        xfwd: true,
        secure: false,
        followRedirects: true,
        agent: url.protocol === 'https:' ? httpsAgent : httpAgent,
        headers: {
          'accept-encoding': '*;q=1,gzip=0'
        }
      }
      ctx.req.oldPath = ctx.req.url
      const regexp = new RegExp("\^\\/" + chainName, 'g');
      ctx.req.url = ctx.req.url.replace(regexp, '')

      ctx.res.on('close', () => { 
        resolve()
      })

      ctx.res.on('finish', () => { 
        resolve()
      })

      proxy.web(ctx.req, ctx.res, opts, e => {
        const status = {
          ECONNREFUSED: 503,
          ETIMEOUT: 504
        }[e.code];
        ctx.status = status || 500;
        resolve()
      })
    })
  }

  return {
    routes
  }
}

export default ProxyController;