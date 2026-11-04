# 录入僧 · 手机传图中转站

手机扫一下电脑上录入僧网页版的二维码，拍完照一传，照片经这里转到电脑，电脑收齐自己开工。

- 照片在手机上先加密才发出来；开锁的钥匙只在手机和电脑上（藏在二维码里），从不经过这里。站里只有加密过的数据。
- 电脑取走就删；没人取的放 3 天自动删。一个通道最多攒 300 张，一张最大约 1.9MB。
- 只认录入僧网页（https://qianshoulab.github.io）发来的请求。
- Cloudflare Worker + Durable Object（SQLite），免费版就够。Cloudflare 从这个仓库自动部署：推上 main 就更新。

本地跑测试（不用 Cloudflare 账号）：`npm install && npm test`

录入僧：https://qianshoulab.github.io/luruseng/

## 铁件点钞机 · 免钥匙通道（/count）

铁件点钞机网页（https://qianshoulab.github.io/gongshi/count/）不填钥匙时，把照片（JPEG base64）POST 到 `/count`，这里拿 Song 的谷歌钥匙问 Gemini（先 2.5 Pro，额度没了换 Flash），回答原样还回去。

- 钥匙是 Cloudflare 后台的 Secret：`GEMINI_KEY`（备胎 `GEMINI_KEY2`）。没加的话 `/count` 回 503，网页让用户贴自己的钥匙。
- 提示词和回答格式写死在 `src/count.js`，网页只能递照片；只收 JPEG，夹带引号的不收。
- 额度（新加坡时间零点重置）：每个 IP 每天 40 次，所有人每天 400 次（`COUNT_IP_MAX`、`COUNT_ALL_MAX`），超了回 429，网页让用户贴自己的钥匙。
- 谷歌的报错原样还回去，钥匙抹成 ***。
