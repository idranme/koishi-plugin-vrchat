import { Context, Schema, Binary } from 'koishi'

export const name = 'vrchat'

export const inject = ['http']

export interface Config { }

export const Config: Schema<Config> = Schema.object({})

export function apply(ctx: Context, config: Config) {
  let auth: string | undefined

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

        const cookie = authResp.headers.get('set-cookie').split('; ')[0]
        const emailOtpResp = await ctx.http.post('https://api.vrchat.cloud/api/1/auth/twofactorauth/emailotp/verify', { code }, {
          headers: {
            'User-Agent': 'VRCX 2026.02.11',
            'Cookie': cookie
          },
          responseType: 'json',
          validateStatus: status => status < 500
        })
        if (emailOtpResp.verified) {
          auth = cookie
          return '登录成功'
        }
      } else {
        ctx.logger.info(authResp)
      }
    })

  ctx.command('vrchat-avatars <keyword:text>', '检索 VRChat 模型')
    .option('number', '-n <value:number>', { fallback: 10 })
    .action(async ({ session, options }, keyword) => {
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
        } catch { }
      }

      await session.send(`<message forward>${avatarlist.map(e =>
        `<message>模型名：
${e.name}

描述：
${e.description}

模型 ID：
${e.id}

作者名：
${e.authorName}

状态：
${e.releaseStatus}

创建时间：
${new Date(e.created_at).toLocaleString()}

最后更新时间：
${new Date(e.updated_at).toLocaleString()}<img src="${e.imageUrl}"></img></message>`
      ).join('')}</message>`)

      await session.bot.deleteMessage(session.channelId, msgId)
    })

  ctx.command('vrchat-worlds <keyword:text>', '检索 VRChat 世界')
    .option('number', '-n <value:number>', { fallback: 10 })
    .action(async ({ session, options }, keyword) => {
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

      const messages: string[] = []

      for (const item of resp) {
        let tags = []
        for (const tag of item.tags) {
          if (tag.startsWith('author_tag_')) {
            tags.push(tag.replace('author_tag_', ''))
          }
        }
        messages.push(`<message>世界名：
${item.name}

作者名：
${item.authorName}

地图内总在线人数：
${item.occupants}

世界 ID：
${item.id}

作者添加的标签：
${tags.join(', ')}

收藏人数：
${item.favorites}

创建时间：
${new Date(item.created_at).toLocaleString()}

最后更新时间：
${new Date(item.updated_at).toLocaleString()}<img src="${item.imageUrl}"></img></message>`)
      }

      await session.send(`<message forward>${messages.join('')}</message>`)

      await session.bot.deleteMessage(session.channelId, msgId)
    })
}
