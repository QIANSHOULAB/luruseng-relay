# 录入僧 · 手机传图中转站

手机扫一下电脑上录入僧网页版的二维码，拍完照一传，照片经这里转到电脑，电脑收齐自己开工。

- 照片在手机上先加密才发出来；开锁的钥匙只在手机和电脑上（藏在二维码里），从不经过这里。站里只有加密过的数据。
- 电脑取走就删；没人取的放 3 天自动删。一个通道最多攒 300 张，一张最大约 1.9MB。
- 只认录入僧网页（https://qianshoulab.github.io）发来的请求。
- Cloudflare Worker + Durable Object（SQLite），免费版就够。Cloudflare 从这个仓库自动部署：推上 main 就更新。

本地跑测试（不用 Cloudflare 账号）：`npm install && npm test`

录入僧：https://qianshoulab.github.io/luruseng/

## 铁件点钞机 · 免钥匙通道（/count）

铁件点钞机网页（https://qianshoulab.github.io/gongshi/count/）不填钥匙时，把照片（JPEG base64）POST 到 `/count`，这里拿 Song 的谷歌钥匙问 Gemini（先 gemini-3.8-flash，额度没了或用不了换 gemini-3.5-flash-lite；不用 2.5，新钥匙用不了），回答原样还回去。

- 钥匙是 Cloudflare 后台的 Secret：`GEMINI_KEY`（备胎 `GEMINI_KEY2`）。没加的话 `/count` 回 503，网页让用户贴自己的钥匙。
- 提示词和回答格式写死在 `src/count.js`，网页只能递照片；只收 JPEG，夹带引号的不收。
- `?pass=audit`：第二眼。网页把数过的托盘裁大、每件点一个小品红点发过来，这里用写死的复查提示词让模型找没点的（missed）和点错的（extra）。
- 额度（新加坡时间零点重置，按请求算，一张照片两次）：每个 IP 每天 60 次，所有人每天 600 次（`COUNT_IP_MAX`、`COUNT_ALL_MAX`），超了回 429，网页让用户贴自己的钥匙。
- 谷歌的报错原样还回去，钥匙抹成 ***。

## 一叶笺 ⇄ 大管家 · 信箱（/dgj，施工单 065）

一叶笺（iPhone）和大管家（电脑、掌机）之间的双向信箱，代替 iCloud 文件夹那根慢管子。接口见 qianye 仓库 `ios/docs/大管家接口.md` 的 v2、v3 两节。

v3（施工单 070）：电脑、掌机两台大管家连同一个信箱，寄给大管家的每封信只交给一台。

- 连上时说自己是谁：`?as=pc&who=desk`（电脑）、`?as=pc&who=handheld`（掌机）。不带 `who` 的老掌机照 v2 走，排在最后。
- 挑一台在线的推过去，先电脑、后掌机；在线照旧是 90 秒内连上过或 ping 过。
- 拿到的那台马上回「接了」：`{"t":"take","seq":N}`，站里回 `{"t":"took"}`；已经转给别的机器、或者信没了，回 `{"t":"nope","by"?,"gone"?}`，那就别干。
- 20 秒没回「接了」，或者接了以后断了（10 秒没回来）、90 秒没 ping，转给下一台在线的。接了的信，别的机器连上来也不给。老掌机不会回「接了」，推过去就算它接了。
- 回手机的信带 `re=<请求的 id>`：同一个请求已经回过一份，第二份回 `{"again":true,"dup":true}`，不存。
- `hello`、`state`、推给手机的 `{"t":"pc"}` 多一个 `pcs`：哪几台在线，`["desk","handheld"]`（老掌机写 `pc`）。手机不用改，有一台在线 `pc` 就是 true。

- 地址：`/dgj/<信箱号>/...`，信箱号 128 位随机（32 个小写十六进制字），知道号就能用。跟录入僧（`/r`）、点钞机（`/count`）互不相干。
- 信两头加密（AES-256-GCM），钥匙只在手机和掌机上，站里只有密文，日志不记内容。
- 手机 app、掌机发请求不带 Origin：不带 Origin 的只有 `/dgj` 放行；别的网站来的一律 403。
- 两个方向：`to=pc`（手机 → 大管家）、`to=phone`（大管家 → 手机）。收信的一方连着 WebSocket 就马上推（48KB 以下的小信内容跟着推送走）；没连着就攒着，下次连上时 `hello` 里一次给全。
- 收信的一方处理完回 ack（WebSocket 发 `{"t":"ack","seq":N}`，或 `DELETE /dgj/<信箱号>/msg/<N>`）才删；没人取的 7 天删，两头都会收到 `gone`。
- 大管家在不在线由站里判断：掌机的 WebSocket（`?as=pc`）连着、而且 90 秒内 ping 过就算在线。手机收到 `{"t":"pc","on":…,"seen":…}`。
- 一封最大 24MB（一行存不下就拆成 1.9MB 一片存，取的时候拼回一整封）；一个信箱没取的最多 200 封、64MB，超了回 413 / 429。
- 掌机长连着不费额度：WebSocket 休眠（`acceptWebSocket`），文本 `ping` 由站里自动回 `pong`，不叫醒 Durable Object。

| 做什么 | 怎么发 |
|---|---|
| 连上 | `GET /dgj/<信箱号>/ws?as=pc&who=desk|handheld` 或 `?as=phone`（WebSocket）；先收到 `hello`：`{t, v:3, role, who?, pc, pcSeen, pcs, phone, pending, items:[…]}`（大管家的 `items` 只有交给这一台的） |
| 接了（v3） | WebSocket `{"t":"take","seq":N}` → `{"t":"took","seq":N}` 或 `{"t":"nope","seq":N,"by"?,"gone"?}` |
| 寄一封 | `PUT /dgj/<信箱号>/msg?to=pc|phone&mid=<信的 id>[&re=<回的请求 id>]`，正文是密文；回 `{seq, at, parts, pc, phone}`；同一个 mid 再寄回 `again:true`，不存第二份；同一个 re 回过了回 `again:true, dup:true` |
| 有新信 | 推送 `{t:"msg", item:{seq, mid, to, at, size, data?}}`（`data` 是小信的 base64 密文） |
| 取一封 | `GET /dgj/<信箱号>/msg/<seq>`，回整封密文 |
| 收到了 / 撤回 | WebSocket `{"t":"ack","seq":N}` 或 `DELETE /dgj/<信箱号>/msg/<seq>`；两头都收到 `{t:"gone", seq, mid, to}` |
| 看状态 | `GET /dgj/<信箱号>/state` 或 WebSocket `{"t":"state"}` → `{pc, pcSeen, pcs, phone, pending:{pc, phone}}` |
| 列没取的 | `GET /dgj/<信箱号>/msgs?for=pc|phone` |
| 回过没有（v3） | `GET /dgj/<信箱号>/replied/<请求 id>` → `{re, replied, at}`：带这个 re 的回信收过没有（听力稿配之前先问，免得两台都配） |

## 录入僧 ⇄ 大管家 · 认照片（/lr，施工单 089）

录入僧（网页版、电脑版）认刀单照片，先问大管家；大管家不在、没配对、60 秒没回、回了错，录入僧自己跳回 Gemini。代码在 `src/luru.js`。

- 配对：录入僧点「连接大管家」输一次暗号。暗号用大管家的公钥（P-256，`GET /lr/hello` 的 `pub`）加密着过来，站里看不见；对了，大管家给这个录入僧一把它自己的钥匙（也加密着回去），以后照片、结果都用这把钥匙加密。
- 站里只记：配上的录入僧（cid、一句「哪个浏览器、哪台电脑」、配的时间、最后一次用、用了几次、撤了没有），哪个地方输错了几次（IP 加盐哈希）。同一个地方一小时错 10 次锁一小时（`LR_FAILS`、`LR_LOCK_MS`）。
- 照片和结果只在内存里转一手，转完就扔，不存。
- 大管家带口令连上来（`x-lr-token`，站里只存哈希，第一台连上来的定下它）：`GET /lr/pc/ws?who=desk|handheld`。一件活只交一台：先电脑、后掌机；交过去 8 秒没来取就转下一台（`LR_TAKE_MS`）。
- 撤掉的（`POST /lr/pc/revoke`）、站里不认识的录入僧再发照片：403，录入僧退回 Gemini。

| 谁 | 做什么 | 怎么发 |
|---|---|---|
| 录入僧 | 大管家在不在、公钥 | `GET /lr/hello` → `{v, on, pcs, pub}` |
| 录入僧 | 配对 | `POST /lr/pair` `{cid, epk, n, ct}` → `{ok:true, n, ct}` / `{ok:false, wrong:true, left, locked?, until?}`；锁着 429 `{locked, until}`；大管家不在 503 `{off}`；超时 504 |
| 录入僧 | 认一张 | `POST /lr/ask` `{cid, n, ct}` → `{ok:true, n, ct, by}` / `{ok:false, forget}`；撤了 403 `{revoked}`；不认识 403 `{unknown}`；不在 503；75 秒没回 504 |
| 大管家 | 连上、收活 | WebSocket `pc/ws?who=…`，推 `{t:"job", id, kind}`；`GET pc/job/<id>` 取（先来先得，晚了 409）；`POST pc/answer/<id>` 回 |
| 大管家 | 公钥、共用设置、配对表、撤 | `POST pc/pub`、`GET/POST pc/conf`（大管家自己加密的）、`GET pc/state`、`POST pc/revoke {cid}|{all:true}` |

网页只能碰 `hello`、`pair`、`ask`；`pc/…` 带 Origin 的一律 403。
