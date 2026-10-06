# Remotion Slide Video

基于 [Remotion](https://remotion.dev) v4 的自动化视频生产工具。通过 Express API 上传素材、编排镜头，服务端渲染输出 MP4；并内置一整套 Python 音视频/图像处理能力（人脸检测、语音转字幕、去人声、去水印、TTS），覆盖从素材处理到成片输出的完整流程。

## 功能特性

- **幻灯片视频生成**：图片与视频片段混排，支持淡入淡出转场、Ken Burns 运镜、多音轨混音，成片时长按素材自动计算。
- **视频编辑**：视频拼接、按时间轴切割、画面裁剪、音视频分离、音频串联与切割。
- **字幕能力**：文本区域检测（启发式 / 学习型）、语音识别生成字幕（faster-whisper）、音频 + 字幕合成并插入视频。
- **AI 素材处理（Python）**：人脸时间段检测、去人声（Demucs）、去水印 / 去字幕（VSR sttn-auto，支持遮罩）、文本转语音（sherpa-onnx Supertonic 3）。
- **文件与图片**：统一的上传 / 列出 / 删除接口，图片压缩（sharp）。
- **服务端渲染**：基于 `@remotion/renderer`，直接通过 API 输出成片。

## 快速开始

### 环境依赖

- **JS / TS 依赖**：全部声明在 [package.json](package.json)，`npm i` 即可。
- **Node.js**：建议 v22+。
- **Python 隔离环境**（AI 音视频处理，按需启用）：两个环境彼此独立，均不污染系统 Python。
  - [requirements.faceenv.txt](requirements.faceenv.txt) → `.faceenv`（Python 3.11）：人脸检测、语音转字幕、去人声、字幕检测。
  - [requirements.vsrenv.txt](requirements.vsrenv.txt) → `.vsrenv`（Python 3.12）：去水印（VSR sttn-auto）、文本转语音（sherpa-onnx）。
- **ffmpeg / ffprobe**：优先使用系统命令，缺失时自动回退到 Remotion 自带二进制。

```bash
# 1) 安装 JS 依赖
npm i

# 2) 安装 Python 环境（按需使用对应功能时）
conda create -p .faceenv python=3.11 -y
.faceenv/bin/python -m pip install -r requirements.faceenv.txt
.faceenv/bin/python -m pip install --no-deps insightface==2.1

conda create -p .vsrenv python=3.12 -y
.vsrenv/bin/python -m pip install -r requirements.vsrenv.txt

# 3) 启动 Remotion Studio（开发预览）
npm run dev

# 4) 启动渲染 API 服务
npm run server

# 5) TypeScript 检查
npm run lint
```

> Python 环境路径可通过 `FACE_PYTHON` / `WHISPER_PYTHON` / `DEMUCS_PYTHON` / `WM_PYTHON` / `TTS_PYTHON` 等环境变量覆盖，详见下文各 API 说明。

---

## API 文档

渲染 API 服务默认运行在 `http://localhost:3001`。所有返回的 `url` 字段均为相对路径，请自行拼接 IP 和端口。

### 1. 上传文件

统一文件上传，图片、音频、视频均可。通过 `dir` 参数指定子目录（默认 `uploads`）。

```bash
# 上传到默认目录 public/uploads/
curl -X POST http://localhost:3001/api/files/upload \
  -F "file=@/path/to/file.jpg"

# 上传到指定子目录 public/video/
curl -X POST "http://localhost:3001/api/files/upload?dir=video" \
  -F "file=@/path/to/video.mp4"

# 上传音乐到 public/audio/music/
curl -X POST "http://localhost:3001/api/files/upload?dir=audio/music" \
  -F "file=@/path/to/bgm.mp3"

# 自定义文件名（通过 ?name= 指定，保留原扩展名；重名时自动追加短 uuid 避免覆盖）
curl -X POST "http://localhost:3001/api/files/upload?dir=video&name=my_video" \
  -F "file=@/path/to/video.mp4"
```

> `dir` 必须通过 **URL 查询参数**（`?dir=...`）传递，multipart 表单字段不可用于指定目录。
> `name` 可通过 URL 查询参数（`?name=...`）或 multipart 表单字段（`name=xxx`，需放在 `file` 字段之前）传递。

**响应**:
```json
{
  "success": true,
  "file": {
    "filename": "video/uuid-xxxx.mp4",
    "originalName": "video.mp4",
    "size": 1048576,
    "url": "/static/video/uuid-xxxx.mp4"
  }
}
```

单文件最大 200MB，无文件类型限制。文件自动同步到 bundle 目录，可直接用于渲染。

> 旧端点 `/api/upload` 和 `/api/audio/upload` 仍然可用，内部转发到统一上传逻辑。

---

### 2. 列出目录文件

```bash
# 列出 public/uploads/ 目录
curl http://localhost:3001/api/files

# 列出指定子目录
curl "http://localhost:3001/api/files?dir=video"
```

**响应**:
```json
{
  "dir": "video",
  "files": [
    {
      "filename": "video/uuid-xxxx.mp4",
      "name": "uuid-xxxx.mp4",
      "url": "/static/video/uuid-xxxx.mp4",
      "size": 1048576
    }
  ]
}
```

> 旧端点 `/api/uploads` 仍然可用。

---

### 3. 删除文件

`dir` 可以省略，直接从 `files` 路径中提取目录。支持跨目录批量删除。

```bash
# 不写 dir，直接写完整路径（跨目录批量）
curl -X POST http://localhost:3001/api/files/delete \
  -H "Content-Type: application/json" \
  -d '{
    "files": ["uploads/aaa.jpg", "video/bbb.mp4", "audio/music/ccc.mp3"]
  }'

# 纯文件名时需指定 dir
curl -X POST http://localhost:3001/api/files/delete \
  -H "Content-Type: application/json" \
  -d '{
    "files": ["aaa.jpg", "bbb.mp4"],
    "dir": "video"
  }'
```

**响应**:
```json
{
  "success": true,
  "results": [
    { "filename": "video/uuid-xxxx.mp4", "deleted": true }
  ]
}
```

> 旧端点 `/api/uploads/delete` 仍然可用。

---

### 4. 渲染视频

核心接口。支持两种图片输入模式和丰富的镜头/转场效果。

#### 模式一：简单模式（`images`，向下兼容）

```bash
curl -X POST http://localhost:3001/api/render \
  -H "Content-Type: application/json" \
  -d '{
    "images": ["uploads/photo.jpg"],
    "durationPerImage": 90
  }'
```

#### 模式二：高级模式（`slides`，支持每张图独立运镜）

```bash
curl -X POST http://localhost:3001/api/render \
  -H "Content-Type: application/json" \
  -d '{
    "slides": [
      {"src": "photo1.jpg", "camera": {"effect": "kenBurnsIn", "intensity": 0.3}},
      {"src": "photo2.jpg", "camera": {"effect": "panRight"}},
      {"src": "photo3.jpg", "camera": {"effect": "blurIn"}},
      {"src": "photo4.jpg", "camera": {"effect": "rotate"}}
    ],shi
    "transition": "fade",
    "transitionDuration": 15,
    "durationPerImage": 90
  }'
```

#### 完整示例（运镜 + 转场 + 音轨）

```bash
curl -X POST http://localhost:3001/api/render \
  -H "Content-Type: application/json" \
  -d '{
    "slides": [
      {"src": "intro.jpg", "camera": {"effect": "blurIn"}},
      {"src": "scene1.jpg", "camera": {"effect": "kenBurnsIn", "intensity": 0.2}},
      {"src": "scene2.jpg", "camera": {"effect": "panLeft"}},
      {"src": "ending.jpg", "camera": {"effect": "kenBurnsOut"}}
    ],
    "transition": "fade",
    "transitionDuration": 15,
    "audioTracks": [
      {"src": "narration.mp3", "volume": 1.0},
      {"src": "bgm.mp3", "volume": 0.3}
    ],
    "durationPerImage": 90
  }'
```

#### 运镜效果（camera）

每张图可独立配置运镜，不传则无效果。

| 效果 | 值 | 说明 |
|------|-----|------|
| 缓慢放大 | `"kenBurnsIn"` | 从 1.0x 放大到 1.0+intensity 倍（默认） |
| 缓慢缩小 | `"kenBurnsOut"` | 从 1.0+intensity 倍缩小到 1.0x |
| 向左平移 | `"panLeft"` | 图片从左向右移动（平移效果） |
| 向右平移 | `"panRight"` | 图片从右向左移动 |
| 向上平移 | `"panUp"` | 图片从上往下移动 |
| 向下平移 | `"panDown"` | 图片从下往上移动 |
| 轻微旋转 | `"rotate"` | 缓慢旋转 intensity×4 度 |
| 模糊入场 | `"blurIn"` | 前 30% 时长从模糊变清晰 |
| 无效果 | `"none"` | 静帧显示 |

`intensity` 参数范围 0-1，默认 0.2，控制运镜强度。

#### 转场效果（transition）

| 效果 | 值 | 说明 |
|------|-----|------|
| 淡入淡出 | `"fade"` | 默认，前一张淡出同时后一张淡入 |
| 滑动切换 | `"slide"` | 后一张滑入推走前一张 |
| 擦除切换 | `"wipe"` | 后一张从左到右擦除前一张 |
| 无转场 | `"none"` | 瞬间切换 |

`transitionDuration` 控制转场持续帧数，默认 15 帧（0.5 秒）。

#### 音频支持

**单音频**（`audioUrl`）和**多音轨**（`audioTracks`）两种模式：

| 音轨参数 | 类型 | 必填 | 说明 |
|----------|------|------|------|
| `src` | `string` | 是 | 音频路径：远程 URL，或 `public/` 下的任意路径（如 `audio/music/bgm.mp3`、`video/av/xxx/audio.wav`），也会兜底查找 `public/audio/` 及其 `music/` 子目录 |
| `volume` | `number` | 否 | 音量 0-1，默认 1.0（背景音乐设 0.2~0.3） |
| `startFrom` | `number` | 否 | 延迟帧数，默认 0 |

#### 请求参数完整列表

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `images` | `string[]` | 见说明 | 简单模式：图片路径数组（与 `slides` 二选一） |
| `slides` | `object[]` | 见说明 | 高级模式：`[{src, camera?}]`（与 `images` 二选一） |
| `camera` | `object` | 否 | 全局默认运镜（`{effect, intensity?}`） |
| `transition` | `string` | 否 | 转场类型：`fade`(默认) / `slide` / `wipe` / `none` |
| `transitionDuration` | `number` | 否 | 转场持续帧数，默认 15 |
| `audioUrl` | `string` | 否 | 单音频路径 |
| `audioTracks` | `object[]` | 否 | 多音轨数组 |
| `durationPerImage` | `number` | 否 | 每张图片持续帧数，默认 90 |

#### 视频片段（`slides` 高级模式）

`slides` 每一项都可是图片或视频（可混排）。视频**必须是 `public/` 下的本地文件**（不支持远程 http 地址），`type` 可省略——扩展名 `.mp4/.webm/.mov/.mkv/.m4v/.avi` 会自动识别为视频。

```bash
curl -X POST http://localhost:3001/api/render \
  -H "Content-Type: application/json" \
  -d '{
    "slides": [
      {"src": "intro.jpg", "camera": {"effect": "blurIn"}},
      {"src": "uploads/clip1.mp4", "type": "video", "trimStartSeconds": 1.5, "volume": 0.8},
      {"src": "uploads/clip2.mp4", "durationSeconds": 5}
    ],
    "transition": "fade"
  }'
```

| 视频字段 | 类型 | 说明 |
|----------|------|------|
| `src` | `string` | `public/` 下的路径（如 `uploads/clip.mp4`） |
| `type` | `string` | `"video"`；省略按扩展名推断 |
| `durationSeconds` / `durationInFrames` | `number` | 该段时长；**不传则播完整个素材** |
| `trimStartSeconds` | `number` | 从素材开头跳过的秒数 |
| `volume` | `number` | 原声音量 0-1，**默认 0（静音）** |

**帧率与分辨率**：成片帧率和画布尺寸**以 `slides` 中第一段视频为准**（帧率取整，画布取其宽高）；若 `slides` 中没有视频（纯图片），则保持默认 `1280×720@30`。

**比例适配**：画布比例与素材比例不一致时，视频按 `contain` 缩放**完整显示**，四周以黑边补足（不裁切画面）。

- 视频片段默认静音，需发声请显式设置 `volume`（或用 `audioTracks` 铺底）。
- 指定时长（`durationSeconds`/`durationInFrames`）超过素材可用长度时，超出部分以黑帧补足，并在响应 `warnings` 中提示。

#### 响应

```json
{
  "success": true,
  "output": {
    "filename": "video/render/video-uuid-xxxx.mp4",
    "url": "/static/video/render/video-uuid-xxxx.mp4",
    "sizeBytes": 178311,
    "durationInFrames": 100,
    "fps": 30
  }
}
```

### 视频时间系统

帧率默认 **30 fps**；当 `slides` 含视频时，**以第一段视频的帧率为准**（纯图片仍为 30 fps）。总帧数计算：

```
总帧数 = Σ slides[].durationInFrames − (slides.length − 1) × transitionDuration
```

示例：5 张图，每张 90 帧，转场 15 帧

```
总帧数 = 5 × 90 − 4 × 15 = 390 帧
总时长 = 390 / 30 = 13 秒
```

#### 音频时序示意

```
时间轴:  0s        3s        6s        9s        12s       15s
图片:    [图1]────[图2]────[图3]────[图4]────[图5]
         ▷fade◁   ▷fade◁   ▷fade◁   ▷fade◁
旁白:    ◼━━━━━━━━◼━━━━━━━━◼━━━━━━━━◼━━━━━━━━◼
背景乐:  ◼━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━◼
```

---

### 5. 列出本地音乐

列出 `public/audio/music/` 目录中可用的音乐文件。

```bash
curl http://localhost:3001/api/audio
```

**响应**:
```json
{
  "files": [
    { "filename": "background.mp3", "url": "/audio/music/background.mp3" }
  ]
}
```

> `public/audio/` 用于存放其他音频（如上传的对话），音乐文件请放入 `public/audio/music/`。

---

### 6. 串联音频

将多个音频文件按顺序合并为一个，适合将分段对话拼接成完整音频。

```bash
curl -X POST http://localhost:3001/api/audio/concat \
  -H "Content-Type: application/json" \
  -d '{
    "files": ["dialogue1.mp3", "dialogue2.mp3", "dialogue3.mp3"],
    "outputName": "full_dialogue.mp3"
  }'
```

**请求参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `files` | `string[]` | 是 | 至少 2 个音频文件名（位于 `public/audio/` 中） |
| `outputName` | `string` | 否 | 输出文件名（可选，会自动加 UUID 前缀防冲突） |

**响应**:
```json
{
  "success": true,
  "file": {
    "filename": "uuid_full_dialogue.mp3",
    "originalFiles": ["dialogue1.mp3", "dialogue2.mp3", "dialogue3.mp3"],
    "size": 5820834,
    "durationInSeconds": 180.072,
    "url": "/audio/uuid_full_dialogue.mp3"
  }
}
```

合并后的文件会自动同步到 bundle 目录，可直接用于 `audioUrl` 或 `audioTracks`。

---

### 7. 获取音频时长

获取 `public/audio/` 中某个音频文件的时长（秒）。

```bash
# 文件名需要 URL 编码（中文等特殊字符）
curl "http://localhost:3001/api/audio/background.mp3/duration"
```

**响应**:
```json
{
  "filename": "background.mp3",
  "durationInSeconds": 60.024,
  "size": 1940278
}
```

---

### 8. 视频拼接

拼接多个视频，自动处理分辨率/比例差异（等比缩放 + 黑边填充），支持逐段静音和替换音频。

```bash
curl -X POST http://localhost:3001/api/video/concat \
  -H "Content-Type: application/json" \
  -d '{
    "files": [
      {"filename": "video/clip1.mp4"},
      {"filename": "video/clip2.mp4", "mute": true},
      {"filename": "video/clip3.mp4", "audioTrack": "中式.mp3"}
    ],
    "outputWidth": 1920,
    "outputHeight": 1080
  }'
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `files` | `array` | 是 | 视频文件列表（至少 2 个） |
| `files[].filename` | `string` | 是 | 视频文件路径 |
| `files[].mute` | `boolean` | 否 | 是否静音该段（默认 `false`） |
| `files[].audioTrack` | `string` | 否 | 替换/叠加的音频文件 |
| `outputWidth` | `number` | 否 | 目标宽度（默认第一个视频的宽度） |
| `outputHeight` | `number` | 否 | 目标高度（默认第一个视频的高度） |

#### 行为说明

- **分辨率不一致**：所有视频等比缩放至目标分辨率，不拉伸变形，空白区域填充黑色（letterbox/pillarbox）
- **帧率**：统一为 30fps
- **音频**：
  - 不设参数：保留原音频
  - `"mute": true`：移除该段音频（无声）
  - `"audioTrack": "中式.mp3"` 且不静音：混合原音频与新音频
  - 同时设置 `mute` + `audioTrack`：仅使用新音频

#### 响应

```json
{
  "success": true,
  "output": {
    "filename": "video/uuid_concat.mp4",
    "url": "/static/video/uuid_concat.mp4",
    "sizeBytes": 100273,
    "width": 640,
    "height": 480,
    "totalDurationSeconds": 9,
    "videoCount": 3
  }
}
```

输出文件保存到 `public/video/`，自动同步到 bundle 目录。

---

### 9. 视频按时间轴切割

按时间轴将视频切割成多个片段：每个 `{start, end}` 生成一个独立视频文件，统一存入本地目录，并返回文件数组（含附加参数与访问地址）。

```bash
curl -X POST http://localhost:3001/api/video/cut \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/6494255c-d09e-4fad-9ead-ecf98eb3856f.mp4",
    "segments": [
      {"start": 0,     "end": 11.04, "hasFace": false, "faceCount": 0},
      {"start": 11.04, "end": 15.36, "hasFace": true,  "faceCount": 1},
      {"start": 15.36, "end": 16.32, "hasFace": false, "faceCount": 0}
    ]
  }'
```

上传视频（multipart，`segments` 以 JSON 字符串传入）：

```bash
curl -X POST http://localhost:3001/api/video/cut \
  -F "file=@/path/to/video.mp4" \
  -F 'segments=[{"start":0,"end":2},{"start":2,"end":4}]'
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `segments` | `array` | 是 | 时间段数组，仅使用每项的 `start` / `end`（秒） |
| `segments[].start` | `number` | 是 | 起始时间（秒） |
| `segments[].end` | `number` | 是 | 结束时间（秒），须大于 `start`；超出视频时长时收敛到视频结尾 |
| `filename` | `string` | 见说明 | 已有视频路径，与 `file` 二选一 |
| `file` | `file` | 见说明 | 上传视频（multipart，字段名 `file`），与 `filename` 二选一 |

> `segments` 中除 `start`/`end` 外的字段（如 `hasFace`、`faceCount`）仅原样回传到结果，不参与切割。

#### 响应

```json
{
  "success": true,
  "source": { "filename": "uploads/xxx.mp4" },
  "count": 3,
  "dir": "video/cuts/<jobId>",
  "totalBytes": 2944298,
  "segments": [
    {
      "index": 0,
      "start": 0,
      "end": 11.04,
      "durationSeconds": 11.04,
      "hasFace": false,
      "faceCount": 0,
      "filename": "video/cuts/<jobId>/seg_000.mp4",
      "url": "/static/video/cuts/<jobId>/seg_000.mp4",
      "sizeBytes": 1930498
    }
  ]
}
```

- 每个时间段输出一个独立文件，统一放入 `public/video/cuts/<jobId>/`，命名 `seg_000.mp4`、`seg_001.mp4`…，顺序与输入一致。
- 采用 libx264 重编码，切点精确到帧；结果中的 `filename` 可直接用于「8. 视频拼接」或渲染 `slides`。
- 时间段允许重叠；`dir` 为本次结果文件所在目录，可通过 `url` 直接用 HTTP 获取。

---

### 10. 视频 / 音轨分离

将视频的画面与音轨分离：输出一个**无音轨的视频**和一个**音频 WAV** 文件，存入本地目录并返回二者的访问地址。

```bash
curl -X POST http://localhost:3001/api/video/split-av \
  -H "Content-Type: application/json" \
  -d '{ "filename": "uploads/6494255c-d09e-4fad-9ead-ecf98eb3856f.mp4" }'
```

上传视频（multipart，字段名 `file`）：

```bash
curl -X POST http://localhost:3001/api/video/split-av \
  -F "file=@/path/to/video.mp4"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filename` | `string` | 见说明 | 已有视频路径，与 `file` 二选一 |
| `file` | `file` | 见说明 | 上传视频（multipart，字段名 `file`），与 `filename` 二选一 |

#### 响应

```json
{
  "success": true,
  "source": { "filename": "uploads/xxx.mp4" },
  "duration": 15.083,
  "hasAudio": true,
  "video": {
    "filename": "video/av/<jobId>/video.mp4",
    "url": "/static/video/av/<jobId>/video.mp4",
    "sizeBytes": 6705051
  },
  "audio": {
    "filename": "video/av/<jobId>/audio.wav",
    "url": "/static/video/av/<jobId>/audio.wav",
    "sizeBytes": 2016062
  }
}
```

- 无音轨视频采用 `-map 0:v:0 -c:v copy -an`，直接复制视频流并剥离音频，**无损且快速**，输出 `video.mp4`。
- 音频采用 `-map 0:a:0 -vn -c:a pcm_s16le`，输出为 16bit PCM WAV，保留原始采样率与声道，文件名为 `audio.wav`。
- 结果统一存入 `public/video/av/<jobId>/`，并同步到 bundle 的 `public/` 下，`url` 可直接用 HTTP 获取。
- 源视频**没有音轨**时，`hasAudio` 为 `false`、`audio` 为 `null`，仅产出无音轨视频，并附带 `warning` 字段提示。

---

### 11. 视频画面裁剪

从视频四周裁掉边框（crop）：`top` / `left` / `right` / `bottom` 指定各边要裁掉的像素数，输出尺寸为源尺寸减去四边裁剪量，存入本地并返回访问地址。

```bash
curl -X POST http://localhost:3001/api/video/crop \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/6494255c-d09e-4fad-9ead-ecf98eb3856f.mp4",
    "top": 20, "left": 0, "right": 0, "bottom": 20
  }'
```

上传视频（multipart，字段名 `file`）：

```bash
curl -X POST http://localhost:3001/api/video/crop \
  -F "file=@/path/to/video.mp4" \
  -F "top=20" -F "bottom=20"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `top` | `number` | 否 | 顶部裁掉的像素数，默认 `0` |
| `left` | `number` | 否 | 左侧裁掉的像素数，默认 `0` |
| `right` | `number` | 否 | 右侧裁掉的像素数，默认 `0` |
| `bottom` | `number` | 否 | 底部裁掉的像素数，默认 `0` |
| `filename` | `string` | 见说明 | 已有视频路径，与 `file` 二选一 |
| `file` | `file` | 见说明 | 上传视频（multipart，字段名 `file`），与 `filename` 二选一 |

> 四个裁剪量均须 `>= 0`；输出宽高必须为正数，否则返回 `400`。为满足 H.264 要求，输出宽高会向下取整为偶数。

#### 响应

```json
{
  "success": true,
  "source": { "filename": "uploads/xxx.mp4" },
  "original": { "width": 1920, "height": 1080 },
  "crop": { "top": 20, "left": 0, "right": 0, "bottom": 20 },
  "output": { "width": 1920, "height": 1040 },
  "duration": 15.072,
  "hasAudio": true,
  "video": {
    "filename": "video/crops/<jobId>/cropped.mp4",
    "url": "/static/video/crops/<jobId>/cropped.mp4",
    "sizeBytes": 1234567
  }
}
```

- 输出统一存入 `public/video/crops/<jobId>/cropped.mp4`，并同步到 bundle 的 `public/` 下。
- 采用 libx264 重编码，切点即裁切区域；音频以 AAC 保留（源无音轨时忽略）。
- 结果中的 `filename` 可直接用于「8. 视频拼接」或渲染 `slides`。

---

### 12. 字幕检测（自动定位 / 启发式 / 学习型）

默认使用基于 PP-OCR DBNet 的**学习型**文本检测（`engine` 默认 `ml`），对低对比、彩色、半透明、竖排文字（如屏幕右侧竖排水印）更鲁棒；也可通过 `engine: "heuristic"` 切换到基于 OpenCV 的启发式算法（白字 + 黑描边）。

**不传 `regions` 时全画面自动检测**（`ml` 引擎）：跨帧采样整帧，自动定位并返回画面中**所有出现文字的位置**（如底部横排字幕 + 右侧竖排水印各作为一个元素），**无需手动指定区域**。若要只针对指定位置扫描，可传 `regions` 数组；此时 `heuristic` 才会只扫底部（见下）。两种模式的 `regions` 均为**扁平数组**（`regions[0]`、`regions[1]`…），每项带 `detected`，检出时给出该处文字的**绝对像素坐标 + 置信度**；字幕与竖排水印不作区分。响应顶层另有 `segments` 数组，把**整段视频按时间切成连续片段**（含**有文字**与**无文字**两种），每段带 `hasText` 标记（按跨帧采样得到，而非单张图片）。

自动模式下 `regions[]` 按画面位置（`top`、`left`）列出所有检出的文字区域；指定 `regions` 时则按请求顺序一一对应。全局 `detect.detected` 为各区域的或逻辑——任一区域在全片任意时刻出现过文字即为 `true`；`segments` 把整段视频铺满为连续的 `hasText` 片段（见「regions 数组」与「segments 数组」）。

`heuristic` 算法要点（仅 `engine: "heuristic"`）：采样区域 → 灰度 → 取「亮像素（白字）∩ 邻近暗像素（黑描边）」 → 形态学闭运算 → 投影 → 跨帧频率累加 → 取连续热带；再在该带内对每帧的垂直方向文本范围取并集，得到最大外接框。为拒绝高纹理背景（松针/植被/云层）造成的误检，热带还需通过四重门槛：带内文字像素占比（`minRowRatio` / `maxRowRatio`）、跨帧出现频率（`freqThreshold`）、带平均激活度（`minConfidence`）与带最小厚度（`minBandHeightRatio`）。因此对大块均匀亮背景（白墙、白衣服、雪地）与偶发纹理不敏感。

`ml` 自动模式（不传 `regions`）算法要点：逐帧对整个画面跑 DBNet → 二值化文本掩膜 → 跨帧累加每个像素被判为文字的帧数 → 只保留在不少于 `autoFreqThreshold` 比例采样帧中出现过的像素（滤掉偶发噪声）→ 形态学膨胀把同一行/同一竖排的字符合并 → 连通域得到每个文字区域的外接框与置信度，按位置排序输出。因此它天然能同时给出底部横排字幕与侧面竖排水印等多个区域。

> 朝向 `orientation`：`horizontal`（默认，如底部横排字幕）按**行投影**检测横向文字带；`vertical`（如屏幕右侧竖排文字/水印）按**列投影**检测纵向文字带。

```bash
curl -X POST http://localhost:3001/api/video/detect-subtitles \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/6494255c-d09e-4fad-9ead-ecf98eb3856f.mp4",
    "sampleFps": 2
  }'
```

上传视频（multipart，字段名 `file`）：

```bash
curl -X POST http://localhost:3001/api/video/detect-subtitles \
  -F "file=@/path/to/video.mp4" \
  -F "sampleFps=2"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sampleFps` | `number` | 否 | 每秒采样帧数，默认 `1`（越大越准越慢） |
| `maxSamples` | `number` | 否 | 最多采样帧数，默认 `600` |
| `regionRatio` | `number` | 否 | 仅 `heuristic` 且未指定 `regions` 时生效：只检测底部该比例区域，默认 `0.35` |
| `regions` | `array` | 否 | 多区域分别扫描，见下方「多区域扫描」。每个元素：`{ name?, left, top, right, bottom, orientation?, anchor? }`。不传时 `ml` 走全画面自动检测，`heuristic` 退化为底部单区域 |
| `engine` | `string` | 否 | 检测引擎：`ml`（默认，PP-OCR DBNet 学习型，见下方「学习型检测」）或 `heuristic`（OpenCV 启发式）。下表 `brightThresh` ~ `edges` 仅对启发式生效；`ml` 专用参数见「学习型检测」 |
| `autoFreqThreshold` | `number` | 否 | 仅 `ml` 且未指定 `regions`（自动模式）时生效：像素需在不少于该比例的采样帧中被判为文字才保留，默认 `0.02`（调大更稳、框更紧，调小召回更多） |
| `autoMinAreaRatio` | `number` | 否 | 仅 `ml` 且未指定 `regions`（自动模式）时生效：报告一个自动区域所需的最小稳定文字面积占画面比例，默认 `0.0004` |
| `brightThresh` | `number` | 否 | 白字亮度阈值（0-255），默认 `200` |
| `darkThresh` | `number` | 否 | 描边暗像素阈值（0-255），默认 `100` |
| `minRowRatio` | `number` | 否 | 行被判为字幕行的最小亮像素占比，默认 `0.05`（调大可拒绝松针/云层/植被等高纹理背景） |
| `maxRowRatio` | `number` | 否 | 行被判为字幕行的最大亮像素占比，默认 `0.7` |
| `freqThreshold` | `number` | 否 | 行在采样帧中出现的频率阈值，默认 `0.05`（真实字幕往往只在少数帧出现） |
| `minConfidence` | `number` | 否 | 字幕带平均激活度下限，默认 `0.04`（剔除弱/偶发的纹理带） |
| `minBandHeightRatio` | `number` | 否 | 字幕带最小高度占视频高度的比例，默认 `0.015`（剔除 1-3px 的偶发纹理带） |
| `gapBridge` | `number` | 否 | 桥接同一字幕带内空隙的最大行数，默认 `8` |
| `padding` | `number` | 否 | 上沿额外上移的像素（更保险地裁净），默认 `0` |
| `edges` | `boolean` | 否 | 启用边缘检测，用于非白色字幕，默认 `false` |
| `upscale` | `number` | 否 | 兼容字段（仅回显），默认 `0`；不再影响输出 |
| `filename` | `string` | 见说明 | 已有视频路径，与 `file` 二选一 |
| `file` | `file` | 见说明 | 上传视频（multipart，字段名 `file`），与 `filename` 二选一 |

#### 响应

```json
{
  "success": true,
  "video": {
    "width": 1920,
    "height": 1080,
    "fps": 25,
    "frameCount": 375,
    "duration": 15.083
  },
  "detect": {
    "engine": "ml",
    "mode": "auto",
    "detected": true,
    "sampleFps": 2,
    "sampledFrames": 30,
    "upscale": 0,
    "gapBridge": 1,
    "params": {
      "detThresh": 0.3,
      "minTextRatio": 0.002,
      "minBoxArea": 20,
      "detLimit": 960,
      "minDetSize": 320,
      "autoFreqThreshold": 0.02,
      "autoMinAreaRatio": 0.0004
    }
  },
  "regions": [
    {
      "name": "region0",
      "detected": true,
      "left": 585,
      "top": 266,
      "right": 594,
      "bottom": 298,
      "width": 10,
      "height": 33,
      "orientation": "vertical",
      "confidence": 0.9319
    },
    {
      "name": "region1",
      "detected": true,
      "left": 234,
      "top": 306,
      "right": 404,
      "bottom": 316,
      "width": 171,
      "height": 11,
      "orientation": "horizontal",
      "confidence": 0.9872
    }
  ],
  "segments": [
    { "start": 0.0, "end": 12.5, "hasText": true },
    { "start": 12.5, "end": 20.0, "hasText": false },
    { "start": 20.0, "end": 40.96, "hasText": true }
  ],
  "file": { "filename": "uploads/xxx.mp4" }
}
```

响应按 **video / detect / regions / segments** 组织：

- `video`：视频基本信息（`width` / `height` / `fps` / `frameCount` / `duration`）。
- `detect`：检测本身的参数与元信息：
  - `engine`：`"ml"`（默认）或 `"heuristic"`；
  - `mode`：`"auto"`（`ml` 且未传 `regions`，全画面自动检测）或 `"regions"`（按指定区域扫描）；
  - `detected`：**全局**是否检测到文字（各区域或逻辑，任一区域检出即为 `true`）；
  - `sampleFps` / `sampledFrames`：实际采样帧率与采样帧数（`sampleFps` 受 `maxSamples` 收敛）；
  - `upscale`：兼容字段（仅回显）；
  - `gapBridge`：实际使用的空隙桥接样本数；
  - `params`：本次生效的检测参数（启发式为 `brightThresh` ~ `edges`，ml 为 `detThresh` / `minTextRatio` / `minBoxArea` / `detLimit` / `minDetSize`；自动模式另含 `autoFreqThreshold` / `autoMinAreaRatio`）；
  - `message`：全局未检测到任何文字时的提示（仅在 `detected: false` 时出现）。
- `regions[]`：**扁平数组**。自动模式（`mode: "auto"`）按画面位置（`top`、`left`）列出所有检出的文字区域；指定 `regions` 时按请求顺序一一对应。字幕与竖排水印不作区分：
  - `name`：区域名（自动模式为 `region{i}`，指定模式为请求的 `name` 或默认 `region{i}`）；
  - `detected`：该区域在全片是否出现过文字；
  - 检出时（`detected: true`）附该处文字的**绝对像素坐标**与置信度：
    - `left` / `top`：文字框左沿 / 上沿的像素坐标（含）；
    - `right` / `bottom`：文字框右沿 / 下沿的像素坐标（含）；
    - `width` / `height`：该框宽高（`width = right - left + 1`，`height = bottom - top + 1`）；
    - `confidence`：该位置的置信度；
    - 即遮罩矩形在帧坐标里为 `x = left`、`y = top`、`w = width`、`h = height`。
  - 未检出时（`detected: false`）`left` / `top` / `right` / `bottom` / `width` / `height` 均为 `null`，`confidence` 为 `0`。
- `segments[]`：整段视频**按时间切成的连续片段**（秒），首尾相接、无缝铺满 `[0, duration]`，含**有文字**与**无文字**两种：
  - `start` / `end`：该片段的起止秒数；
  - `hasText`：该片段是否含文字（`true` / `false`）；任一处（含侧面水印）有文字即算「有文字」；
  - 全片任意位置都有文字（如全程水印）时为单个 `{ "start": 0, "end": duration, "hasText": true }`；全片无文字时为单个 `{ "start": 0, "end": duration, "hasText": false }`。
- 未检测到任何文字时 `detect.detected: false`、`segments` 为单个 `hasText: false` 的整段，并在 `detect.message` 给出提示。

#### 多区域扫描（regions）

通过 `regions` 数组可对画面中**多个位置分别扫描**（例如底部横排字幕 + 屏幕右侧竖排水印）。每个区域独立走一遍检测流程，**响应中的 `regions[]` 会按请求顺序列出全部区域**，检测到文字的项带坐标且 `detected: true`，未检出的项 `detected: false`（坐标均为 `null`）；全局 `detect.detected` 为各区域的或逻辑——任一区域在全片任意时刻出现过文字即为 `true`（见「regions 数组」）。

每个区域的坐标均为**帧尺寸的比例（0~1）**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | `string` | 否 | 区域名，默认 `region{i}` |
| `left` / `top` / `right` / `bottom` | `number` | 是 | 区域范围（比例，左/上含、右/下不含） |
| `orientation` | `string` | 否 | `horizontal`（默认，行投影）/ `vertical`（列投影，用于竖排文字） |
| `anchor` | `string` | 否 | 热带贴合的区域边缘：横向默认 `bottom`，纵向默认 `right`；可选 `bottom` / `top` / `left` / `right` |

```bash
curl -X POST http://localhost:3001/api/video/detect-subtitles \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/xxx.mp4",
    "sampleFps": 2,
    "regions": [
      { "name": "bottom-sub", "left": 0, "top": 0.65, "right": 1, "bottom": 1, "orientation": "horizontal", "anchor": "bottom" },
      { "name": "right-wm",   "left": 0.9, "top": 0, "right": 1, "bottom": 0.8, "orientation": "vertical",   "anchor": "right" }
    ]
  }'
```

- 不传 `regions` 时：`ml`（默认）走**全画面自动检测**（`mode: "auto"`），自动返回画面中所有含文字的位置（底部字幕、侧面水印等各作为一项，按位置排序）；`heuristic` 退化为单区域默认模式——按 `regionRatio` 只扫底部，`regions[]` 恒含 1 项。
- 所有请求的区域都会出现在 `regions[]` 中（与请求的 `regions` 一一对应），未检出文字的项 `detected: false`；若某个区域的参数非法（如 `regions` JSON 格式错误），整次请求会直接报错。

#### 全画面自动检测（ml 且不传 regions）

`engine: "ml"`（默认）且**不传 `regions`** 时，无需手动指定区域，脚本会对整帧逐帧跑 DBNet，自动定位并返回画面中所有出现文字的位置：

```bash
curl -X POST http://localhost:3001/api/video/detect-subtitles \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/xxx.mp4",
    "sampleFps": 2
  }'
```

上例在测试视频上同时返回右侧竖排水印（`orientation: vertical`）与底部横排字幕（`orientation: horizontal`）两项。灵敏度由两个参数控制：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `autoFreqThreshold` | `number` | 否 | 像素需在不少于该比例的采样帧中被判为文字才保留，默认 `0.02`（调大更稳、框更紧，调小召回更多但噪声更多） |
| `autoMinAreaRatio` | `number` | 否 | 报告一个自动区域所需的最小稳定文字面积占画面比例，默认 `0.0004`（调大可滤掉过小的噪声区域） |

> 自动模式下 `regions[]` 的项由位置排序决定，`name` 为 `region0`、`region1`…，与请求无关；每项附 `orientation` 与 `confidence`。若整帧都没检出稳定文字，`detect.detected: false`、`regions` 为空数组。

#### 学习型检测（engine: "ml"）

`engine: "ml"` 时改用 PP-OCRv4 DBNet 文本检测 ONNX 模型逐帧推理：crop →（竖排先旋转 90°）→ DBNet 概率图 → 按 `detThresh` 二值化得文本掩膜 → 文本像素占区域比例 ≥ `minTextRatio` 即判为「有文字」；竖排检测后概率图会旋转回原方向，因此输出的文字框仍为原帧坐标。对细小的竖排水印，检测前会把 crop 放大到最长边不小于 `minDetSize` 像素（小图直接送 DBNet 会漏检）。**不传 `regions` 时**，则跳过 crop、直接对整帧推理，并把跨帧稳定的文本掩膜连通成区域（见上方「全画面自动检测」）。

推理默认走 GPU（onnxruntime `CUDAExecutionProvider`），不可用时自动回退 CPU；可通过 `provider` / `deviceId` 指定。其余请求/响应字段（`regions`、`upscale` 等）与启发式完全一致。

```bash
curl -X POST http://localhost:3001/api/video/detect-subtitles \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/xxx.mp4",
    "engine": "ml",
    "provider": "cuda",
    "deviceId": 0,
    "sampleFps": 1,
    "regions": [
      { "name": "right-wm", "left": 0.885, "top": 0.66, "right": 0.955, "bottom": 0.9, "orientation": "vertical", "anchor": "right" }
    ]
  }'
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `engine` | `string` | 否 | 指定 `"ml"`；不传时默认即为 `ml`（传 `"heuristic"` 才切换） |
| `provider` | `string` | 否 | ONNX Runtime 执行提供器：`auto`（默认，有 CUDA 则用 CUDA）、`cpu`、`cuda` |
| `deviceId` | `number` | 否 | CUDA 设备序号，默认 `0` |
| `model` | `string` | 否 | 自定义 DBNet ONNX 模型路径，默认项目内 `models/ch_PP-OCRv4_det_mobile.onnx` |
| `detThresh` | `number` | 否 | 概率图二值化阈值，默认 `0.3`（漏检可调低） |
| `minTextRatio` | `number` | 否 | 判定「有文字」的最小文本像素占比，默认 `0.002` |
| `minBoxArea` | `number` | 否 | 计为一行文字的最小连通域面积（px），默认 `20` |
| `detLimit` | `number` | 否 | 检测输入最长边上限（px），默认 `960`（超大区域会缩放以省算力） |
| `minDetSize` | `number` | 否 | 检测前把 crop 最长边放大到至少该像素，默认 `320`（`0` = 不放大）；细竖排水印需 >0，否则易漏检 |
| `gapBridge` | `number` | 否 | 桥接相邻「有文字」样本间最多这么多个「无文字」样本；ml 默认 `1`，启发式默认 `8` |

`ml` 引擎的响应在 `detect` 段内包含：`engine`（固定 `"ml"`）、`model`、`providers`（实际使用的执行提供器）、`availableProviders`，以及 `params` 下的 `detThresh` / `minTextRatio` / `minBoxArea` / `detLimit` / `minDetSize`。

**依赖与模型**

- Python 侧需 `onnxruntime`；启用 GPU 用 `onnxruntime-gpu`。检测脚本 `python/text_detect.py` 会自行预加载 `nvidia-*-cu12` 运行库，**无需**手动设置 `LD_LIBRARY_PATH`；也可用 `MYVIDEO_CUDA_LIBS`（`os.pathsep` 分隔的目录）指定额外 CUDA 库目录。
- GPU 需匹配的 CUDA/cuDNN：本机验证组合为 `onnxruntime-gpu==1.20.2` + CUDA 12 + cuDNN **9.1**（cuDNN 过新会导致 Conv 节点执行失败并报 `CUDNN_BACKEND_API_FAILED`）。
- 模型默认位于 `models/ch_PP-OCRv4_det_mobile.onnx`（RapidAI/RapidOCR 的 PP-OCRv4 mobile 检测模型，约 4.7MB）；缺失时脚本报错，可用 `model` 参数指向其他路径。

**启发式 vs 学习型**：学习型（`ml`，**默认**）对低对比、彩色、半透明与竖排文字更稳，但需要 ONNX 模型与（可选）GPU 环境，单帧成本更高；启发式（`heuristic`）无需模型、纯 OpenCV、速度快，适合画面下方的高对比白色硬字幕。

#### regions 数组

响应不再区分字幕与竖排水印。`regions[]` 即检测结果本体：指定 `regions` 时**按请求顺序列出每个区域**（请求 2 个区域 → 2 项，依此类推），用 `regions[0]`、`regions[1]`… 按下标访问，与请求的 `regions` 一一对应；自动模式（`ml` 且不传 `regions`）则按画面位置（`top`、`left`）列出所有自动检出的文字区域，`name` 为 `region0`、`region1`…。每项都带 `detected` 标记：检出文字的项直接给出该处的绝对像素坐标与置信度（`left` / `top` / `right` / `bottom` / `width` / `height` / `confidence`），未检出的项 `detected: false`、坐标均为 `null`、`confidence` 为 `0`。

- 指定模式下每项对应请求中的一个区域，不存在跨区域的合并；自动模式每项对应一个自动检出的文字区域。每项都可独立使用。
- 全局 `detect.detected` = 是否有任一区域检出文字。
- `gapBridge` 用于桥接相邻「有文字」样本间的小空隙，之后再把整段视频切成连续的 `hasText` 片段（影响 `segments`），不改变 `regions` 的构成；`upscale` 为兼容字段，不再影响输出。

#### segments 数组

`segments[]` 把**整段视频按时间切成首尾相接的连续片段**（秒），由跨帧采样得到，而非单张图片：对所有区域逐帧判定，只要任一区域在该帧出现文字即记为「有文字」；先按 `gapBridge` 桥接相邻的「有文字」样本（把其间很短的「无文字」样本并入），再把相邻的同类样本合并为一个个 `{ start, end, hasText }` 区间。**所有区间无缝铺满 `[0, duration]`，既包含有文字的片段，也包含无文字的片段。**

- `start` / `end`：该片段的起止秒数。片段边界取相邻采样时刻的中点，因此区间首尾相接、不重叠、不留空隙。
- `hasText`：该片段是否含文字（`true` / `false`），直接用于判断，无需依赖「段存在即有文字」的约定。
- 判定「某帧有文字」以**检出区域**为准：只要任一 `regions[]` 区域在该帧有足够文字像素即算有文字，因此**只有侧面水印、没有字幕的帧也会被算作有文字**，不会因水印像素较少而被漏判。
- 全片任意位置都有文字（如全程有竖排水印）即为单个 `{ "start": 0, "end": duration, "hasText": true }`；全片无文字时为单个 `{ "start": 0, "end": duration, "hasText": false }`。

#### 用 regions 遮罩 / 裁剪去字幕

取出一处文字的坐标，即可在渲染/合成时叠加一个纯色矩形盖住它（帧坐标里矩形为 `x = left`、`y = top`、`w = width`、`h = height`）。自动模式下 `regions[]` 按位置排序，可按需挑选任意一项：

```bash
curl -s -X POST http://localhost:3001/api/video/detect-subtitles \
  -H "Content-Type: application/json" \
  -d '{"filename":"uploads/xxx.mp4","sampleFps":2}' | jq '.regions[1]'
# => { "name": "region1", "detected": true, "left": 234, "top": 306, "right": 404, "bottom": 316,
#      "width": 171, "height": 11, "orientation": "horizontal", "confidence": 0.9872 }
```

若改为直接裁掉底部文字，把「文字上沿到视频底部的距离」（`video.height - regions[1].top`）传给 `/api/video/crop` 的 `bottom` 即可：

```bash
curl -X POST http://localhost:3001/api/video/crop \
  -H "Content-Type: application/json" \
  -d '{"filename":"uploads/xxx.mp4","bottom":100}'
```

> 注意：硬裁会连同文字下方的画面一起裁掉；遮罩则不损失画面。以上精调参数（`edges` / `padding` / `freqThreshold` / `minRowRatio` / `minConfidence` / `minBandHeightRatio`）仅对 `engine: "heuristic"` 生效——非白色字幕建议加 `edges: true`；若底部有台标/水印，可能一并被计入而偏多，可用 `padding` 或调大 `freqThreshold` 缓解。`ml` 自动模式则通过 `autoFreqThreshold` / `autoMinAreaRatio` 控制灵敏度。

---

### 13. 压缩图片

将图片压缩为 JPEG 格式，支持质量调节和等比缩放。支持上传新文件或对已上传的文件进行压缩。

#### 方式一：压缩已有文件（JSON）

```bash
curl -X POST http://localhost:3001/api/images/compress \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/uuid-xxx.jpg",
    "quality": 70,
    "maxWidth": 1280
  }'
```

#### 方式二：上传并压缩（multipart）

```bash
curl -X POST http://localhost:3001/api/images/compress \
  -F "file=@/path/to/image.png" \
  -F "quality=60" \
  -F "maxWidth=1280"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filename` | `string` | 见说明 | 已有文件路径（与 `file` 二选一） |
| `file` | `file` | 见说明 | 上传新文件（与 `filename` 二选一） |
| `quality` | `number` | 否 | JPEG 质量 1-100，默认 80 |
| `maxWidth` | `number` | 否 | 最大宽度，等比缩放，不放大 |
| `maxHeight` | `number` | 否 | 最大高度，等比缩放，不放大 |

#### 响应

```json
{
  "success": true,
  "file": {
    "filename": "uploads/uuid-xxx.jpg",
    "url": "/static/uploads/uuid-xxx.jpg",
    "sizeBytes": 15854,
    "originalSizeBytes": 86989,
    "compressionRatio": 82,
    "width": 800,
    "height": 450,
    "format": "jpeg",
    "quality": 70
  }
}
```

> 输出始终为 JPEG 格式，使用 mozjpeg 编码。文件自动同步到 bundle 目录，可直接用于渲染。

---

### 14. 人脸时间段检测

使用 InsightFace 沿时间轴检测视频中出现面孔和不出现面孔的连续时间段，输出按时间顺序排列的 JSON 数组。适合用于自动跳过无人脸片段、标注有人脸素材等场景。

#### 方式一：上传视频（multipart）

```bash
curl -X POST http://localhost:3001/api/face/detect \
  -F "file=@/path/to/video.mp4" \
  -F "sampleFps=2"
```

#### 方式二：检测已有文件（JSON）

`filename` 指向 `public/` 下已有视频（如 `uploads/xxx.mp4`、`video/xxx.mp4`）。

```bash
curl -X POST http://localhost:3001/api/face/detect \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/001-0d612480.mp4",
    "sampleFps": 2
  }'
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | `file` | 见说明 | 上传视频（multipart，字段名 `file`），与 `filename` 二选一 |
| `filename` | `string` | 见说明 | 已有视频路径，与 `file` 二选一 |
| `sampleFps` | `number` | 否 | 每秒采样帧数，默认 2（越大越精细、越慢） |
| `detThresh` | `number` | 否 | 人脸检测置信度阈值，默认 0.5 |
| `detSize` | `number` | 否 | 检测器输入尺寸，默认 640 |
| `maxSamples` | `number` | 否 | 单次最多采样帧数，默认 1200（超出会按比例降低采样率） |
| `ctxId` | `number` | 否 | 推理设备，默认 -1（CPU）；≥0 使用对应 GPU |
| `upscale` | `number` | 否 | 有脸时间段前后各延长的秒数，默认 0；>0 时最小 0.01。无脸段相应缩短，整体范围不变 |
| `name` | `string` | 否 | 模型包名，默认 `buffalo_l` |

#### 响应

```json
{
  "success": true,
  "duration": 15.083,
  "fps": 24,
  "sampleFps": 2,
  "upscale": 0,
  "sampledFrames": 31,
  "facesFound": 16,
  "segments": [
    { "start": 0,   "end": 0.5, "hasFace": false, "faceCount": 0 },
    { "start": 0.5, "end": 1.5, "hasFace": true,  "faceCount": 1 },
    { "start": 1.5, "end": 5,   "hasFace": false, "faceCount": 0 },
    { "start": 5,   "end": 6.5, "hasFace": true,  "faceCount": 2 }
  ]
}
```

#### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `duration` | `number` | 视频总时长（秒） |
| `fps` | `number` | 视频原始帧率 |
| `sampleFps` | `number` | 实际使用的采样帧率 |
| `upscale` | `number` | 实际生效的延长秒数（已按最小 0.01 归一化） |
| `sampledFrames` | `number` | 实际采样的帧数 |
| `facesFound` | `number` | 检测到面孔的采样帧数 |
| `segments[]` | `array` | 时间段数组，按时间顺序排列 |
| `segments[].start` | `number` | 该时间段起始时间（秒） |
| `segments[].end` | `number` | 该时间段结束时间（秒） |
| `segments[].hasFace` | `boolean` | 该时间段是否包含面孔 |
| `segments[].faceCount` | `number` | 该时间段内采样到的最大人脸数 |

- 相邻采样点状态相同则合并为同一时间段，各段首尾相连、覆盖整个视频（`0` → `duration`）。
- `upscale` 用于在检测结果基础上给有脸时间段「留出余量」：例如 `upscale=1` 时，每个有脸段前后各延长 1 秒，无脸段相应缩短，所有时间段总和仍等于视频时长；扩展后相互重叠的有脸段会自动合并。
- `ctxId=0` 并已安装 CUDA 版 onnxruntime 时可启用 GPU 加速，CPU 推理也已足够（15s 视频约 4.5s）。

> 该端点依赖 Python 隔离环境 `.faceenv`（InsightFace + onnxruntime + opencv），不会污染系统 Python；检测模型放在 `python/.insightface/models/buffalo_l/`。环境路径可通过 `FACE_PYTHON`、脚本路径通过 `FACE_SCRIPT` 环境变量覆盖。

---

### 15. 语音转字幕（faster-whisper）

输入音频（或视频，自动抽取音轨），用 faster-whisper 提取中文语音，输出带时间轴的 SRT 字幕；字幕文件存入本地，并同时返回 SRT 文本与访问地址。

```bash
curl -X POST http://localhost:3001/api/transcribe \
  -H "Content-Type: application/json" \
  -d '{ "filename": "audio/xxx.mp3" }'
```

上传音频 / 视频（multipart，字段名 `file`）：

```bash
curl -X POST http://localhost:3001/api/transcribe \
  -F "file=@/path/to/audio.mp3"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filename` | `string` | 见说明 | `public/` 下已有音频/视频路径，与 `file` 二选一 |
| `file` | `file` | 见说明 | 上传音频/视频（multipart，字段名 `file`），与 `filename` 二选一 |
| `language` | `string` | 否 | 语音语言，默认 `zh`；填 `auto` 自动判别 |
| `model` | `string` | 否 | 模型规格，默认 `small`（可选 `base` / `medium` / `large-v3` 等） |
| `device` | `string` | 否 | 推理设备，默认 `cpu`（可填 `cuda`） |
| `computeType` | `string` | 否 | 计算精度，默认 `int8`（可填 `float16` / `float32` 等） |
| `beamSize` | `number` | 否 | 解码 beam size，默认 `5` |
| `noVad` | `boolean` | 否 | 设为 `true` 关闭 VAD 静音过滤（默认开启） |
| `initialPrompt` | `string` | 否 | 初始提示词，可引导专有名词识别 |
| `modelRoot` | `string` | 否 | 模型存放/下载目录，默认 `python/.whisper-models` |

#### 响应

```json
{
  "success": true,
  "source": { "filename": "audio/xxx.mp3", "size": 249836 },
  "language": "zh",
  "languageProbability": 1.0,
  "duration": 30.92,
  "model": "small",
  "segmentCount": 17,
  "srt": "1\n00:00:00,000 --> 00:00:03,440\n被婚的姐妹快别跟我一样踩坑了\n\n...",
  "srtFile": {
    "filename": "subtitles/<jobId>/subtitle.srt",
    "url": "/static/subtitles/<jobId>/subtitle.srt",
    "sizeBytes": 1046
  },
  "segments": [
    { "index": 0, "start": 0.0, "end": 3.44, "text": "被婚的姐妹快别跟我一样踩坑了" }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `language` | `string` | 识别出的语言 |
| `languageProbability` | `number` | 语言判别置信度 |
| `duration` | `number` | 字幕覆盖时长（秒），等于最后一段结束时间 |
| `srt` | `string` | 完整 SRT 字幕文本 |
| `srtFile` | `object` | 已保存的 SRT 文件信息（`filename` / `url` / `sizeBytes`） |
| `segments[]` | `array` | 字幕分段，含 `index` / `start` / `end` / `text` |

- 字幕文件保存至 `public/subtitles/<jobId>/subtitle.srt`，并同步到 bundle 的 `public/` 下，`url` 可直接用 HTTP 获取。
- 视频输入会由 PyAV 自动抽取音轨，无需先做音视频分离。
- 首次运行会自动下载所选模型（经 `hf-mirror` 镜像、禁用 xet），下载后缓存在 `python/.whisper-models/`。

> 该端点复用项目内 Python 隔离环境 `.faceenv`（faster-whisper + ctranslate2 + PyAV），不会污染系统 Python。环境路径可通过 `WHISPER_PYTHON`、脚本路径通过 `WHISPER_SCRIPT` 环境变量覆盖。

---

### 16. 去人声（Demucs）

输入音频（或视频，自动抽取音轨），用 Demucs 分离音轨并去除人物讲话（`vocals`），输出只保留背景音的 `no_vocals` 音轨（= `drums` + `bass` + `other`）；文件存入本地并返回访问地址。可选同时保留全部四个分轨。

```bash
curl -X POST http://localhost:3001/api/remove-vocals \
  -H "Content-Type: application/json" \
  -d '{ "filename": "audio/xxx.mp3" }'
```

上传音频 / 视频（multipart，字段名 `file`）：

```bash
curl -X POST http://localhost:3001/api/remove-vocals \
  -F "file=@/path/to/video.mp4" \
  -F "format=mp3" \
  -F "keepStems=true"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filename` | `string` | 见说明 | `public/` 下已有音频/视频路径，与 `file` 二选一 |
| `file` | `file` | 见说明 | 上传音频/视频（multipart，字段名 `file`），与 `filename` 二选一 |
| `model` | `string` | 否 | Demucs 模型名，默认 `htdemucs` |
| `device` | `string` | 否 | 推理设备，默认 `cpu`（可填 `cuda`） |
| `format` | `string` | 否 | 输出格式，`wav`（默认）或 `mp3` |
| `mp3Bitrate` | `number` | 否 | MP3 码率（kbps），默认 `320`，仅 `format=mp3` 时生效 |
| `shifts` | `number` | 否 | 时间位移增强次数，默认 `1`（越大越慢、质量略好） |
| `overlap` | `number` | 否 | 分段重叠比例，默认 `0.25` |
| `segment` | `number` | 否 | 单段长度（秒），默认由模型决定 |
| `jobs` | `number` | 否 | 并行任务数，默认 `0`（自动） |
| `int24` | `boolean` | 否 | 输出 24bit PCM（默认 16bit） |
| `float32` | `boolean` | 否 | 输出 32bit float PCM（仅 wav） |
| `keepStems` | `boolean` | 否 | 设为 `true` 时额外返回四个分轨文件 |
| `repo` | `string` | 否 | 模型目录，默认 `python/.demucs-models` |

#### 响应

```json
{
  "success": true,
  "source": { "filename": "001-0d612480.mp4", "size": 6956052 },
  "model": "htdemucs",
  "device": "cpu",
  "samplerate": 44100,
  "channels": 2,
  "durationSeconds": 15.072,
  "stems": ["drums", "bass", "other", "vocals"],
  "removed": "vocals",
  "audio": {
    "filename": "audio/no-vocals/<jobId>/no_vocals.wav",
    "url": "/static/audio/no-vocals/<jobId>/no_vocals.wav",
    "sizeBytes": 2760352
  },
  "stemFiles": {
    "drums": { "filename": "audio/no-vocals/<jobId>/stems/drums.wav", "url": "/static/...", "sizeBytes": 2760352 },
    "bass":  { "filename": "audio/no-vocals/<jobId>/stems/bass.wav",  "url": "/static/...", "sizeBytes": 2760352 },
    "other": { "filename": "audio/no-vocals/<jobId>/stems/other.wav", "url": "/static/...", "sizeBytes": 2760352 },
    "vocals": { "filename": "audio/no-vocals/<jobId>/stems/vocals.wav", "url": "/static/...", "sizeBytes": 2760352 }
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `audio` | `object` | 去人声后的背景音文件（`filename` / `url` / `sizeBytes`） |
| `removed` | `string` | 被去除的音轨名，固定为 `vocals` |
| `durationSeconds` | `number` | 音频时长（秒） |
| `samplerate` / `channels` | `number` | 输出采样率 / 声道数（htdemucs 为 44100 / 2） |
| `stems` | `array` | 模型分离出的全部分轨名 |
| `stemFiles` | `object` | 仅在 `keepStems=true` 时返回，各分轨文件信息 |

- 输出保存至 `public/audio/no-vocals/<jobId>/`，并同步到 bundle 的 `public/` 下，`url` 可直接用 HTTP 获取。
- 视频输入会先用 ffmpeg 抽取音轨为 44.1k 立体声 WAV 再送入 Demucs；源文件无音轨时返回 `400`。
- 若源音频本身几乎只有人声（无背景音乐），去人声后输出会接近静音，属正常结果。
- CPU 推理速度约为实时的 2 倍（15s 音频约 8s）。

> 该端点复用项目内 Python 隔离环境 `.faceenv`（Demucs + PyTorch CPU + torchaudio），不会污染系统 Python。模型 `htdemucs` 存放于 `python/.demucs-models/`；环境路径可通过 `DEMUCS_PYTHON`、脚本路径通过 `DEMUCS_SCRIPT`、模型目录通过 `DEMUCS_REPO` 环境变量覆盖。

---

### 17. 去水印 / 去字幕（VSR sttn-auto，支持遮罩）

给定视频与要处理的矩形区域（`regions`，通常直接复用 `/api/video/detect-subtitles` 的检测结果），使用 [video-subtitle-remover](https://github.com/YaoFANGUK/video-subtitle-remover) 的 **sttn-auto** 模式对这些区域做内容修复（inpaint）并保留原音轨，**只处理遮罩区域，其余画面原样保留**。适合去除固定位置的台标、水印、硬字幕。

#### 完整示例：先检测，再去水印（一条管道跑通）

先调用 `detect-subtitles` 拿到 `regions[]`，再原样回传给 `remove-watermark`。`regions` 里的 `detected:false` 项会被自动跳过，因此无需手工筛选。

```bash
BASE=http://localhost:3001
VIDEO=uploads/001-0d612480.mp4

# 1) 检测文字/水印区域，取出 regions 数组
REGIONS=$(curl -s -X POST "$BASE/api/video/detect-subtitles" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"$VIDEO\",\"sampleFps\":2}" | jq -c '.regions')

# 2) 用这些 regions 去水印（结果落在 public/video/no-watermark/<jobId>/no_watermark.mp4）
curl -X POST "$BASE/api/video/remove-watermark" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"$VIDEO\",\"regions\":$REGIONS,\"device\":\"cuda\"}" | jq
```

返回（节选）：

```json
{
  "success": true,
  "processed": true,
  "engine": "vsr-sttn-auto",
  "regionsUsed": 4,
  "video": {
    "filename": "video/no-watermark/<jobId>/no_watermark.mp4",
    "url": "/static/video/no-watermark/<jobId>/no_watermark.mp4",
    "sizeBytes": 8783172
  },
  "elapsedSeconds": 105.94
}
```

也可把 `detect-subtitles` 的**完整响应**直接塞进 `regions`（脚本会自动读取其中的 `regions` 字段）：

```bash
curl -s -X POST "$BASE/api/video/detect-subtitles" \
  -H "Content-Type: application/json" -d "{\"filename\":\"$VIDEO\"}" \
  > detect.json

curl -X POST "$BASE/api/video/remove-watermark" \
  -H "Content-Type: application/json" \
  -d "{\"filename\":\"$VIDEO\",\"regions\":$(jq -c . detect.json),\"device\":\"cuda\"}" | jq
```

#### 方式一：上传视频（multipart）

```bash
curl -X POST http://localhost:3001/api/video/remove-watermark \
  -F "file=@/path/to/video.mp4" \
  -F 'regions=[{"left":223,"top":306,"right":407,"bottom":317}]' \
  -F "device=cuda"
```

#### 方式二：处理已有文件（JSON）

`filename` 指向 `public/` 下已有视频（如 `uploads/xxx.mp4`）。`regions` 可为数组，也可直接贴入 `detect-subtitles` 的完整响应对象（脚本会读取其中的 `regions`）。

```bash
curl -X POST http://localhost:3001/api/video/remove-watermark \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "uploads/001-0d612480.mp4",
    "regions": [{ "left": 223, "top": 306, "right": 407, "bottom": 317 }],
    "device": "cuda",
    "deviation": 10
  }'
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | `file` | 见说明 | 上传视频（multipart，字段名 `file`），与 `filename` 二选一 |
| `filename` | `string` | 见说明 | 已有视频路径，与 `file` 二选一 |
| `regions` | `array \| string \| object` | 是 | 要修复的矩形区域，坐标同 `detect-subtitles`：原始分辨率像素、左上角原点、`right`/`bottom` 含端点；每项 `{left, top, right, bottom}`。也接受 JSON 字符串或含 `regions` 的对象；`detected: false` 的项会被跳过。无有效区域时直接原样复制源视频（`processed: false`） |
| `device` | `string` | 否 | 推理设备：`auto`（默认，有 CUDA 用 CUDA，否则 CPU）、`cuda`、`cpu` |
| `deviation` | `number` | 否 | 每个区域向外扩张的像素数，默认 `10`（避免框过小残留边缘） |
| `maxLoadNum` | `number` | 否 | 单个分片处理的最大帧数，默认 `50`（显存不足时会自动下调） |
| `neighborStride` | `number` | 否 | STTN 邻帧步长，默认 `5` |
| `refLength` | `number` | 否 | STTN 参考帧数，默认 `10` |

#### 响应

```json
{
  "success": true,
  "processed": true,
  "engine": "vsr-sttn-auto",
  "device": "cuda",
  "regionsUsed": 1,
  "regions": [{ "left": 223, "top": 306, "right": 407, "bottom": 317 }],
  "video": {
    "width": 1920,
    "height": 1080,
    "fps": 25,
    "frameCount": 750,
    "filename": "video/no-watermark/<jobId>/no_watermark.mp4",
    "url": "/static/video/no-watermark/<jobId>/no_watermark.mp4",
    "sizeBytes": 12345678
  },
  "elapsedSeconds": 42.7,
  "file": { "filename": "uploads/001-0d612480.mp4", "size": 6956052 }
}
```

> 去水印基于时序修复（STTN），对**位置基本固定的水印/台标**效果最好。VSR 的 sttn-auto 内部按垂直位置把区域归入以遮罩为中心的横向条带后修复，因此遮罩框决定「修复哪一竖排高度」，水平方向会整行处理。
>
> 该端点使用项目内**独立** Python 环境 `.vsrenv`（Python 3.12 + torch cu126，兼容 Pascal GPU），源码位于 `vendor/vsr/`，模型 `vendor/vsr/backend/models/sttn-auto/infer_model.pth`，自带 ffmpeg `vendor/vsr/backend/ffmpeg/linux_x64/ffmpeg`。环境路径可通过 `WM_PYTHON`、脚本路径通过 `WM_SCRIPT` 环境变量覆盖；**不会**修改系统环境与 `.faceenv`。

---

### 18. 文本转语音（TTS，sherpa-onnx Supertonic 3）

用项目内模型 `sherpa-onnx-supertonic-3-tts-int8-2026-05-11` 把文本合成为 WAV，默认走 GPU（CUDA），结果落在 `public/audio/tts/<jobId>/speech.wav`。

#### 示例

```bash
# 默认 GPU 推理，英文，说话人 2
curl -X POST http://localhost:3001/api/tts \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, this is a GPU text to speech test.",
    "lang": "en",
    "sid": 2,
    "speed": 1.0
  }'
```

也支持 query 参数（`text` 为必填）：

```bash
curl -X POST "http://localhost:3001/api/tts?text=Hello%20world&lang=en&sid=0"
```

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | `string` | 是 | 要合成的文本，非空 |
| `lang` | `string` | 否 | 语言代码，默认 `en`。模型支持 31 种语言：`en` `ko` `ja` `ar` `bg` `cs` `da` `de` `el` `es` `et` `fi` `fr` `hi` `hr` `hu` `id` `it` `lt` `lv` `nl` `pl` `pt` `ro` `ru` `sk` `sl` `sv` `tr` `uk` `vi` |
| `sid` | `number` | 否 | 说话人 id，范围 `0-9`（共 10 个），默认 `0` |
| `speed` | `number` | 否 | 语速，越大越快，默认 `1.0` |
| `numSteps` | `number` | 否 | 扩散步数，默认 `8`（越大质量越好、越慢） |
| `device` | `string` | 否 | 推理设备：`cuda`（默认，GPU）、`cpu`、`auto`。GPU 不可用时脚本会自动回退 CPU |

#### 响应

```json
{
  "success": true,
  "text": "Hello, this is a GPU text to speech test.",
  "provider": "cuda",
  "fallback": false,
  "sampleRate": 44100,
  "duration": 3.65,
  "sid": 2,
  "lang": "en",
  "audio": {
    "filename": "audio/tts/<jobId>/speech.wav",
    "url": "/static/audio/tts/<jobId>/speech.wav",
    "sizeBytes": 322158
  }
}
```

> 响应中的 `provider` 表示**实际**使用的推理后端（`cuda` / `cpu`），`fallback` 表示是否从请求的设备回退到了 CPU。可通过 `nvidia-smi` 观察显存占用确认 GPU 生效。
>
> 该端点复用项目内隔离的 Python 环境 `.vsrenv`（已安装 CUDA 版 `sherpa-onnx`），CUDA 运行库集中在项目内 `.tts_cuda/`，**不安装任何系统级依赖**。环境路径、脚本路径、模型目录可分别通过 `TTS_PYTHON`、`TTS_SCRIPT`、`TTS_MODEL_DIR` 环境变量覆盖。

---

### 19. 健康检查

```bash
curl http://localhost:3001/api/health
```

**响应**:
```json
{
  "status": "ok",
  "bundleReady": true
}
```

---

### 20. 音频 + 字幕插入视频

按时间轴把每条音频与对应字幕叠加到原视频上：原视频整段铺底并保留原声，音频与字幕绑定在同一个片段里（起点与时长完全一致，天然对齐）。字幕**烧录进画面**（由 Remotion 渲染），成片时长与源视频一致。结果落在 `public/video/insert/<jobId>/output.mp4`。

#### 示例

```bash
curl -X POST http://localhost:3001/api/video/insert \
  -H "Content-Type: application/json" \
  -d '{
    "filename": "video/23842401-dabc-4317-94b1-295db7cf0e7b_merged.mp4",
    "segments": [
      {"index": 2, "start": 157.83, "end": 158.83, "text": "Cocer durante 20-30 minutos", "filename": "audio/tts/64545675-a80a-47cb-ae97-3d41e81ebe1f/speech.wav"},
      {"index": 3, "start": 163.89, "end": 166.37, "text": "Después de cocer unos diez minutos, añadir los champiñones y seguir cocinando", "filename": "audio/tts/xxx/speech.wav"},
      {"index": 4, "start": 170.03, "end": 170.83, "text": "Listo para comer", "filename": "audio/tts/yyy/speech.wav"}
    ],
    "videoVolume": 0.3,
    "ttsVolume": 1
  }'
```

也支持 multipart 上传视频（字段名 `file`），此时 `segments` 以 JSON 字符串形式传入。

#### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `filename` | `string` | 是 | 源视频（`public/` 下相对路径），或改用 multipart 字段 `file` 上传 |
| `segments` | `array` | 是 | 时间段数组，元素见下表 |
| `videoVolume` | `number` | 否 | 原声音量，默认 `1`（保留原声并混合） |
| `ttsVolume` | `number` | 否 | 配音音量，默认 `1` |
| `fontSize` | `number` | 否 | 字幕字号（px），默认取视频高度的 5% |
| `fontColor` | `string` | 否 | 字幕文字颜色，默认 `#FFFFFF` |
| `subtitleBackground` | `string` | 否 | 字幕底色，默认 `rgba(0,0,0,0.55)` |
| `subtitlePosition` | `string` | 否 | 字幕位置：`bottom`（默认）/ `top` / `center` |

`segments` 元素字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `index` | `number` | 否 | 原始下标，仅用于标识与回传 |
| `start` | `number` | 是 | 期望开始时间（秒） |
| `end` | `number` | 否 | 期望结束时间（秒），仅作参考；实际时长以音频为准 |
| `text` | `string` | 否 | 字幕文本，为空则该段只放音频、不显示字幕 |
| `filename` | `string` | 是* | 音频文件（`public/` 下相对路径），与 `url` 二选一 |
| `url` | `string` | 是* | 音频地址，与 `filename` 二选一 |

#### 排程规则（顺延与微调）

1. **时长以音频为准**：每段的音频与字幕时长都取音频实际时长（ffprobe 探测），忽略输入的 `end`，保证字幕与音频始终对齐。
2. **顺延**：每段起点 = `max(输入 start, 上一段结束)`。当音频长于输入区间、或与上一段重叠时自动向后推。
3. **溢出微调**：若整体末尾超出视频时长，按各段之间的空隙**等比例向前收拢**（视频不裁剪、音频不裁剪），把内容尽量塞回视频时长内；各段音频与字幕同步移动，对齐关系不变。
4. 若音频总长本身就超过视频时长，则改为紧密排列，末尾超出部分会被画面截断，并在 `warnings` 中提示。

#### 响应

```json
{
  "success": true,
  "source": { "filename": "...", "duration": 183.995, "fps": 25, "width": 640, "height": 360 },
  "output": {
    "filename": "video/insert/<jobId>/output.mp4",
    "url": "/static/video/insert/<jobId>/output.mp4",
    "sizeBytes": 4389973,
    "durationInFrames": 300,
    "fps": 25,
    "width": 640,
    "height": 360
  },
  "segments": [
    {
      "index": 2,
      "text": "Cocer durante 20-30 minutos",
      "start": 157.83,
      "end": 160.557,
      "audioDuration": 2.727,
      "nominalStart": 157.83,
      "nominalEnd": 158.83,
      "audio": { "filename": "audio/tts/.../speech.wav", "url": "/static/audio/tts/.../speech.wav" }
    }
  ],
  "warnings": []
}
```

> `segments` 中的 `start`/`end` 是**排程后**的最终秒数，可直接用于核对音频与字幕的对齐位置；`nominalStart`/`nominalEnd` 为输入的原值。

---

## 目录结构

```
my-video/
├── src/
│   ├── index.ts               # Remotion 入口（注册根组件）
│   ├── Root.tsx               # 合成定义：SlideVideo / AudioSubtitleVideo
│   ├── KenBurnsImage.tsx      # 图片 Ken Burns 运镜组件
│   ├── VideoClip.tsx          # 视频片段组件
│   ├── AudioSubtitleVideo.tsx # 音频 + 字幕合成组件
│   └── server.ts              # Express API 服务（渲染与各类处理接口）
├── python/                    # AI / 媒体处理脚本
│   ├── face_detect.py         # 人脸时间段检测
│   ├── transcribe.py          # 语音转字幕（faster-whisper）
│   ├── remove_vocals.py       # 去人声（Demucs）
│   ├── text_detect.py         # 文本 / 水印区域检测
│   ├── detect_subtitles.py    # 字幕检测
│   ├── remove_watermark.py    # 去水印 / 去字幕（VSR）
│   └── tts.py                 # 文本转语音（sherpa-onnx）
├── public/                    # 素材与产物（uploads/、audio/、video/、subtitles/）
├── out/                       # Remotion 中间渲染输出（已 gitignore）
├── package.json
└── remotion.config.ts
```

## 技术栈

- **前端 / 渲染**：Remotion v4 + React 19 + TypeScript
- **服务端**：Express 5 + `@remotion/renderer`（服务端渲染）、multer（上传）、sharp（图片处理）
- **样式**：Tailwind CSS v4
- **AI / 媒体处理（Python）**：faster-whisper（语音转字幕）、Demucs（去人声）、VSR sttn-auto（去水印）、sherpa-onnx Supertonic 3（TTS）、ONNX Runtime（人脸 / 文本检测）
