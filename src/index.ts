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
      if (info.currentAvatarImageUrl.includes('file_0e8c4e32-7444-44ea-ade4-313c010d4bae')) {
        avatar = '（vrc+专属个人资料图模型信息不可见）'
        currentAvatarImageUrl = undefined
      } else {
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

    let imgUrl = info.userIcon || info.profilePicOverride || currentAvatarImageUrl
    if (imgUrl === 'https://assets.vrchat.com/system/defaultAvatar.png') {
      imgUrl = 'data:image/webp;base64,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'
    }
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
