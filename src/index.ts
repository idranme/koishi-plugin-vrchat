import { Context, Schema, Binary, Dict } from 'koishi'
import { } from '@koishijs/cache'

declare module '@koishijs/cache' {
  interface Tables {
    vrchat_auth: string
  }
}

export const name = 'vrchat'

export const inject = ['http', 'cache']

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

function countryCodeToEmoji(code: string) {
  if (!code || code.length !== 2) return ''

  const A = 0x1F1E6; // 🇦
  const offset = 'A'.charCodeAt(0)

  const chars = code.toUpperCase().split('')
  const first = A + (chars[0].charCodeAt(0) - offset)
  const second = A + (chars[1].charCodeAt(0) - offset)

  return String.fromCodePoint(first) + String.fromCodePoint(second)
}

export function apply(ctx: Context, config: Config) {
  ctx.command('vrchat-login', '登录 VRChat API')
    .action(async ({ session }) => {
      if (!session.isDirect) return '请通过私聊进行登录'

      await session.send('请输入用户名或邮箱地址：')
      const username = await session.prompt()
      if (!username) return '输入超时。'

      await session.send('请输入密码：')
      const password = await session.prompt()
      if (!password) return '输入超时。'

      const bytes = new TextEncoder().encode(`${encodeURIComponent(username)}:${encodeURIComponent(password)}`)
      const authResp = await ctx.http('https://api.vrchat.cloud/api/1/auth/user', {
        headers: {
          'Authorization': `Basic ${Binary.toBase64(bytes)}`,
          'User-Agent': 'VRCX 2026.02.11'
        },
        responseType: 'json',
        validateStatus: status => status < 500
      })
      if (authResp.data.error) {
        return authResp.data.error.message.slice(1, -1)
      }
      if (authResp.data.requiresTwoFactorAuth?.[0] === 'emailOtp') {
        await session.send('请输入发送到邮箱的验证码：')
        const code = await session.prompt()
        if (!code) return '输入超时。'

        const cookie = authResp.headers.get('set-cookie').split('; ')
        const emailOtpResp = await ctx.http.post('https://api.vrchat.cloud/api/1/auth/twofactorauth/emailotp/verify', { code }, {
          headers: {
            'User-Agent': 'VRCX 2026.02.11',
            'Cookie': cookie[0]
          },
          responseType: 'json',
          validateStatus: status => status < 500
        })
        if (emailOtpResp.verified) {
          const expires = new Date(cookie[3].split('=')[1])
          await ctx.cache.set('vrchat_auth', 'cookie', cookie[0], expires.getTime() - Date.now())
          return '登录成功'
        } else if (emailOtpResp.error) {
          return emailOtpResp.error.message
        }
      } else {
        ctx.logger.info(authResp)
      }
    })

  ctx.command('vrchat-avatars <keyword:text>', '检索 VRChat 模型')
    .option('number', '-n <value:number>', { fallback: 10 })
    .action(async ({ session, options }, keyword) => {
      const auth = await ctx.cache.get('vrchat_auth', 'cookie')
      if (!auth) return '请先登录'
      if (!keyword) return '请输入关键词'

      const [msgId] = await session.send('检索中…')

      const resp = await ctx.http.get(`https://api.avtrdb.com/v3/avatar/search/vrcx?search=${encodeURIComponent(keyword)}&n=${options.number}`, {
        responseType: 'json'
      })

      const avatarlist = []

      for (const item of resp) {
        try {
          const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/avatars/${item.id}`, {
            headers: {
              'User-Agent': 'VRCX 2026.02.11',
              'Cookie': auth
            },
            responseType: 'json'
          })
          avatarlist.push(resp)
        } catch (e) {
          if (e.response.status !== 404) throw e
        }
      }

      if (avatarlist.length === 0) {
        await session.bot.deleteMessage(session.channelId, msgId)
        return '无检索结果'
      }

      await session.send(`<message forward>${avatarlist.map(e =>
        `<message>${genAvatar(e)}</message>`
      ).join('')}</message>`)

      await session.bot.deleteMessage(session.channelId, msgId)
    })

  ctx.command('vrchat-worlds <keyword:text>', '检索 VRChat 世界')
    .option('number', '-n <value:number>', { fallback: 10 })
    .action(async ({ session, options }, keyword) => {
      const auth = await ctx.cache.get('vrchat_auth', 'cookie')
      if (!auth) return '请先登录'
      if (!keyword) return '请输入关键词'

      const [msgId] = await session.send('检索中…')

      const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/worlds/?n=${options.number}&offset=0&sort=relevance&search=${encodeURIComponent(keyword)}&order=descending&tag=system_approved`, {
        headers: {
          'User-Agent': 'VRCX 2026.02.11',
          'Cookie': auth
        },
        responseType: 'json'
      })

      if (resp.length === 0) {
        await session.bot.deleteMessage(session.channelId, msgId)
        return '无检索结果'
      }

      const messages: string[] = []

      for (const item of resp) {
        messages.push(`<message>${genWorld(item)}</message>`)
      }

      await session.send(`<message forward>${messages.join('')}</message>`)

      await session.bot.deleteMessage(session.channelId, msgId)
    })

  ctx.command('vrchat-users <keyword:text>', '检索 VRChat 玩家')
    .option('number', '-n <value:number>', { fallback: 3 })
    .action(async ({ session, options }, keyword) => {
      const auth = await ctx.cache.get('vrchat_auth', 'cookie')
      if (!auth) return '请先登录'
      if (!keyword) return '请输入关键词'

      const [msgId] = await session.send('检索中…')

      const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/users?n=${options.number}&offset=0&search=${encodeURIComponent(keyword)}&customFields=displayName&sort=relevance`, {
        headers: {
          'User-Agent': 'VRCX 2026.02.11',
          'Cookie': auth
        },
        responseType: 'json'
      })

      if (resp.length === 0) {
        await session.bot.deleteMessage(session.channelId, msgId)
        return '无检索结果'
      }

      const users: Dict[] = []

      for (const item of resp) {
        const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/users/${item.id}`, {
          headers: {
            'User-Agent': 'VRCX 2026.02.11',
            'Cookie': auth
          },
          responseType: 'json'
        })
        users.push(resp)
      }

      const messages: string[] = []

      for (const item of users) {
        messages.push(`<message>${await genUser(item, auth)}</message>`)
      }

      await session.send(`<message forward>${messages.join('')}</message>`)

      await session.bot.deleteMessage(session.channelId, msgId)
    })

  ctx.command('vrchat-direct <id:string>', '获取 VRChat 信息')
    .action(async (_, keyword) => {
      const auth = await ctx.cache.get('vrchat_auth', 'cookie')
      if (!auth) return '请先登录'
      if (!keyword) return '请输入 ID'

      if (keyword.startsWith('avtr_')) {
        const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/avatars/${keyword}`, {
          headers: {
            'User-Agent': 'VRCX 2026.02.11',
            'Cookie': auth
          },
          responseType: 'json'
        })
        return genAvatar(resp)
      } else if (keyword.startsWith('wrld_')) {
        const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/worlds/${keyword}`, {
          headers: {
            'User-Agent': 'VRCX 2026.02.11',
            'Cookie': auth
          },
          responseType: 'json'
        })
        return genWorld(resp)
      } else if (keyword.startsWith('usr_')) {
        const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/users/${keyword}`, {
          headers: {
            'User-Agent': 'VRCX 2026.02.11',
            'Cookie': auth
          },
          responseType: 'json'
        })
        return await genUser(resp, auth)
      } else {
        return '不支持该类型 ID'
      }
    })

  function genAvatar(info: Dict) {
    return `模型名：
${info.name}

描述：
${info.description}

模型 ID：
${info.id}

作者名：
${info.authorName}

状态：
${info.releaseStatus}

创建时间：
${new Date(info.created_at).toLocaleString()}

最后更新时间：
${new Date(info.updated_at).toLocaleString()}<img src="${info.thumbnailImageUrl}"></img>`
  }

  function genWorld(info: Dict) {
    const tags = []
    for (const tag of info.tags) {
      if (tag.startsWith('author_tag_')) {
        tags.push(tag.replace('author_tag_', ''))
      }
    }
    return `世界名：
${info.name}

作者名：
${info.authorName}

地图内总在线人数：
${info.occupants}

世界 ID：
${info.id}

作者添加的标签：
${tags.join(', ')}

收藏人数：
${info.favorites}

创建时间：
${new Date(info.created_at).toLocaleString()}

最后更新时间：
${new Date(info.updated_at).toLocaleString()}<img src="${info.thumbnailImageUrl}"></img>`
  }

  async function genUser(info: Dict, auth: string) {
    let avatar = ''
    let currentAvatarImageUrl = info.currentAvatarImageUrl
    if (info.currentAvatarImageUrl.startsWith('https://api.vrchat.cloud')) {
      try {
        const resp = await ctx.http.get(info.currentAvatarImageUrl.slice(0, -7), {
          headers: {
            'User-Agent': 'VRCX 2026.02.11'
          },
          responseType: 'json'
        })
        avatar = resp.name.split(' - ')[1]
      } catch {
        currentAvatarImageUrl = undefined
      }
    }

    let location = info.location
    if (info.location.startsWith('wrld_')) {
      const locationInfo = info.location.split(':')
      const resp = await ctx.http.get(`https://api.vrchat.cloud/api/1/worlds/${locationInfo[0]}`, {
        headers: {
          'User-Agent': 'VRCX 2026.02.11',
          'Cookie': auth
        },
        responseType: 'json'
      })
      const ext = locationInfo[1].split('~')
      location = `${resp.name} #${ext[0]} ${countryCodeToEmoji(ext.at(-1).match(/region\(([^)]+)\)/)[1])}`
    }

    const statusLight = {
      'active': '🟢',
      'join me': '🔵',
      'ask me': '🟠',
      'busy': '🔴',
      'offline': '⚪'
    }[info.status]

    let imgUrl = info.userIcon || currentAvatarImageUrl
    const img = imgUrl ? `<img src="${imgUrl}"></img>` : ''
    return `玩家名：
${info.displayName}

玩家 ID：
${info.id}

状态：
${statusLight} ${info.status} - ${info.statusDescription}

当前位置：
${location}

正在使用的模型：
${avatar}

平台：
${info.platform}

简介：
${info.bio}

快捷链接：
${info.bioLinks.join('\n')}

账号创建日期：
${info.date_joined}${img}`
  }
}
