# dsh-mail

用邮件和正在干活的 DeepSeek Harness 会话双向沟通。

- **离开模式**：侧边栏底部一个全局开关。打开后，所有主会话（不含子代理）的模型都会被告知"用户不在电脑前，有事用 `mail_send` 发邮件"。
- **出站**：模型自己决定何时调用 `mail_send`，收件人固定为你本人。主题自动带会话标记 `[DSH#xxxxxxxx]`。
- **入站**：你回信后，插件按主题里的标记把回信作为新消息送进**原来那个会话**（冷会话会自动恢复），从不新建会话。
- **准入**：发件人白名单（必填、禁通配）+ `Authentication-Results`（DMARC/SPF/DKIM 明确 fail 即拒收）。
- **通用邮箱**：任何 IMAP + SMTP 账号，凭据是用户名 + 密码/授权码。不支持只提供 OAuth2 或 REST 接口的服务。

## 邮箱兼容性

**别把"支持通用 IMAP/SMTP"读成"所有邮箱都测过"。** 实测过的是下面两家，其他厂商请自行验证：

| 服务商 | 状态 | 备注 |
|---|---|---|
| AgentMail（`imap.agentmail.to`） | ✅ 端到端实测 | 2026-10 前一直在用 |
| 163（`imap.163.com` / `smtp.163.com`） | ✅ 收发实测 | 需要授权码（不是登录密码）；暴露过两个服务器差异，见下 |

换邮箱时值得先确认的几件事（都已踩过或已知有坑）：

1. **UIDNEXT 可能不存在**。RFC 3501 里它是可选的，163 就不返回。插件已改为不依赖它。
2. **按序号取单封（`N:N`）可能返回空**。163 只认 `1:*`。插件已改为只用范围取。
3. **长连接的收件箱视图可能冻结**。AgentMail 就是这样，新邮件到了却看不到。插件已改为每次操作新建连接。
4. **认证方式**：多数国内邮箱要在网页端开启 IMAP/SMTP 并生成授权码；Gmail 需要 App Password；Outlook/iCloud 往往要求 OAuth 或应用专用密码。
5. **文件夹命名**：INBOX 之外的名称各异（`已发送` / `Sent` / `Sent Items`）。插件只读写 INBOX，不受影响。
6. **服务端可能强制 ID 命令**（网易系"Unsafe Login"）。imapflow 会自动发送，无需处理。

验证一个新邮箱的最小步骤（`npm run build` 后）：

```bash
# 1. 只读冒烟：登录 + 列信封，不发信（凭据引用名、邮箱账号、IMAP 主机）
node scripts/smoke-mailbox.mjs DSH_MAIL_PASSWORD me@example.com imap.example.com

# 2. 换掉 profile 里 dsh-mail 条目的 config（imap/smtp/passRef/sendAs/notifyTo/allowedFrom），
#    并把条目 id 换一个新的热加载。注意同一时间只能挂一个条目。
# 3. 用 mail_send 发一封，再回信确认注入原会话。
```

`authCheck` 建议保持 `auto`：邮件带 `Authentication-Results` 才检查，不带就只看白名单，避免因服务商不加该头而误拒。

## 工具

| 工具 | 作用 |
|---|---|
| `mail_send` | 给用户发邮件（自动加会话标记与线程头，可带附件） |
| `mail_list` | 列出收件箱最近的邮件，标注是否可信 |
| `mail_read` | 读一封邮件全文 |
| `mail_attachment` | 下载附件到本地 |
| `mail_status` | 通道状态、游标、最近错误、离开模式 |

邮件工具只对主会话开放，子代理调用会被拒绝。

## 安装（开发方式）

```bash
npm install && npm run build          # 产出 lib/index.js（薄壳）+ lib/host.js（单文件 bundle）+ lib/client.js
ln -s "$PWD" ~/.dsh/profiles/<profile>/node_modules/dsh-mail
```

然后在 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: dsh-mail-1
      name: dsh-mail
      config:
        imap: { host: imap.example.com, port: 993, secure: true, user: me@example.com, passRef: DSH_MAIL_PASSWORD }
        smtp: { host: smtp.example.com, port: 465, secure: true }   # user/passRef 缺省沿用 imap
        sendAs: me@example.com          # 插件自己发信的地址（我是谁）
        notifyTo: you@qq.com            # 你收信的地址（人是谁）
        allowedFrom: [you@qq.com]       # 入站白名单：必填，禁止通配
        pollSeconds: 20
        authCheck: auto                 # auto | strict | off
        maxSendPerHour: 30
```

密码不写进配置：在 `~/.dsh/.credentials.yaml` 的 `refs:` 段加 `DSH_MAIL_PASSWORD: <授权码或 API Key>`（或设同名环境变量）。凭据文件改动会被自动感知。

桌面 profile 会热加载新增的 patch 条目，**不需要重启 App**。改了代码或配置后，`npm run build` 并把条目 id 换一个新的即可重新挂载（已存在条目的配置修改不会触发重挂载）。

## 运行数据

`~/.dsh/dsh-mail/`（0700/0600）：

- `state.json`：IMAP 游标、Message-ID 去重集、会话标记表、线程头、离开模式、发信计数
- `audit.jsonl`：每封入站邮件的处理结论（injected / rejected / replied / ignored / failed）、每次出站、每次开关切换
- `loader.jsonl`：插件加载记录（排查"改了没生效"）
- `attachments/`：`mail_attachment` 下载的附件

## 行为细节

- 首次启动以收件箱当前最新一封为基线，不回放历史邮件；`UIDVALIDITY` 变化时重新取基线。
- 没有会话标记的白名单邮件：不注入，自动回一封说明，附最近的会话列表。
- 非白名单、认证失败的邮件：不注入、不回信，只记审计日志。
- 注入失败（如会话被另一进程占用）会重试，3 次仍失败则回信告知。
- 回信里引用的原文（QQ/Gmail/Outlook/`>` 引用）会被剥掉；正文超过 32 KiB 截断，模型可用 `mail_read` 看全文。
- 用 `preset-minimal` 预设的会话关闭了运行时上下文，看不到离开模式提示。

## 测试

```bash
npm test                                   # 单元测试
node scripts/smoke-mailbox.mjs <REF> <user> <imapHost>   # 真实邮箱只读冒烟
```

## 许可证

MIT，见 [LICENSE](LICENSE)。`lib/host.js` 打包了 imapflow、nodemailer、mailparser 及其依赖，各自的许可证原文见 [lib/THIRD_PARTY_LICENSES.txt](lib/THIRD_PARTY_LICENSES.txt)。
