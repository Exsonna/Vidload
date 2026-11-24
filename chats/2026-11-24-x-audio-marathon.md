# X 下载无声 → 四层根因全修通（v0.4.32–v0.4.38），商店暂不传

**Date:** 2026-11-24 (起于 11-19)   **Agent:** Claude Code (Fable 5)   **Commit:** ff0a807
**Topic:** H01 转派：X/Twitter 下载的视频没声音。四轮现场测试逐层挖根因，顺带修弹窗体验。
**Outcome:** 完成 — Anson 确认有声（"可以了"）；商店不传（自用）；会话归档。

## Key decisions
- 商店不传、继续自用（Anson 2026-11-24）(→ DECISIONS.md)
- mux 标准化在 mp4box 内做，不引入 ffmpeg.wasm (→ DECISIONS.md)
- 弹窗只显示当前帖（SPA 清空 + 2 分钟折叠 + 最新在前）(→ DECISIONS.md)

## 四层根因（按发现顺序）
1. **v0.4.32** X fmp4 HLS 音视频分轨（`avc1/` 变体无声，音在 `#EXT-X-MEDIA` 的 `mp4a/` 清单），管线从未下载音轨 → 解析 audioRenditions + `pickAudioRendition()`，复用 DASH 的 `muxAvToMp4` 合成；popup 把音轨 URL 随 `download-stream` 传给 offscreen（关键：选择器默认选变体，offscreen 看不到主清单）。附带：mp4box 默认给音轨写 `hdlr=vide` → 改 `soun`。
2. **v0.4.34** 合成头 `mvhd/tkhd/mdhd` 时长全 0（分片输入 t.duration=0）→ WMF 读不出时长、音频管线不启动（ffmpeg/Chrome 从采样表推导所以测着正常）→ 累加真实采样时长回填。
3. **v0.4.36** Anson 默认播放器是 **VLC**：音轨 timescale 441000（X 原值）+ 音视频数据完全不交错 → VLC 不出声 → timescale 归一到采样率（整数倍精确缩放）+ 按 1 秒窗口交错写分片（验证 438 moof 呈 1x30/2x44 交替）。用他本机 VLC CLI 实际解出 PCM 音频作证。
4. **v0.4.33/35/37/38 周边**：无主清单的裸变体同组配对音轨 + ♪audio/no audio 徽标；`/mp4a/` 行永不显示（曾单独下出纯音频文件 = "声音分离"）；SPA 导航清空旧条目；≥2 分钟旧条目折叠 + 最新在前；twimg 上猜测封面不再显示（posterCtx）。

## 验证方法沉淀（下次照抄）
- 真实数据：Mac mini Chrome 抓 x.com 网络请求拿 master/variant/audio 清单，curl（socks5h 7898 + Referer x.com）下载 init+分段。
- 提取发布源码跑 Node harness（26+12+4 项检查）；ffprobe/全量解码/volumedetect 在 `ssh macmini`；本机 WMF 探针（HasAudio/NaturalDuration）；VLC CLI `--sout` 转 wav（dst 用正斜杠）。
- 文件头直读：hdlr 类型、mvhd/mdhd timescale+duration、mp4a 采样率字段、tfhd track_id 游程（+8 偏移）。
- Chrome `Secure Preferences` 可查未打包扩展的加载路径和版本。

## Files touched
extension/{lib/hls.js, offscreen/offscreen.js, background/service-worker.js, content/content-script.js, popup/popup.js, manifest.json}, CLAUDE.md, wiki/{INDEX.md, topics/hls-download-approach.md, topics/webstore-submission.md}, HANDOFF.md, DECISIONS.md。他的下载文件修复：`sunnyfinance1 (1).mp4`、`@punchbagstudios…(1).mp4`（原名替换）、`UziObi-有声版.mp4`、`punchbagstudios (8)-前23秒.mp4`（剪辑）。

## Open threads
- 无 — HANDOFF §3。商店上传等 Anson 主动提。

## Transcript highlights
786 B 神秘小文件 = X 音频 init 段（v0.4.31 的截图悬案）。每层修完都"还是没声音"，直到把播放器（VLC）当成被测对象本身：音轨内容一直是好的（−12.7 dB），坏的是容器结构。教训：**"文件有音轨" ≠ "用户的播放器会放它"**——验证要落到用户实际的播放栈（WMF 探针、VLC CLI 解音频），不能止于 ffprobe。
