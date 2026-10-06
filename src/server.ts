import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import http from "http";
import https from "https";
import { execFile } from "child_process";
import multer from "multer";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const SERVER_URL = `http://localhost:${PORT}`;

app.use(express.json());
// 支持 form-urlencoded 数组入参，如 filename[0]=uploads/a.mp4&filename[1]=uploads/b.mp4
app.use(express.urlencoded({ extended: true }));

// ========== 静态文件服务 ==========
app.use("/audio", express.static(path.resolve("public/audio")));
app.use("/static", express.static(path.resolve("public")));
app.use("/output", express.static(path.resolve("out")));

// ========== 文件上传配置 ==========
const UPLOAD_DIR = path.resolve("public/uploads");
const AUDIO_DIR = path.resolve("public/audio");
const MUSIC_DIR = path.resolve("public/audio/music");
const PUBLIC_DIR = path.resolve("public");

// MIME -> 扩展名映射，作为自定义名/原文件名都无扩展名时的兜底
const MIME_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "application/ogg": ".ogg",
};

// ========== ffmpeg/ffprobe 路径 ==========
// 优先使用系统命令；系统没有时回退到 Remotion 自带的二进制
function resolveBin(cmd: "ffmpeg" | "ffprobe"): string {
  for (const d of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    try {
      if (fs.existsSync(path.join(d, cmd))) return path.join(d, cmd);
    } catch {
      /* ignore */
    }
  }
  for (const variant of ["compositor-linux-x64-gnu", "compositor-linux-x64-musl"]) {
    const p = path.resolve("node_modules", "@remotion", variant, cmd);
    if (fs.existsSync(p)) return p;
  }
  return cmd; // 最后回退给系统查找（可能报 ENOENT）
}
const FFMPEG = resolveBin("ffmpeg");
const FFPROBE = resolveBin("ffprobe");

const fileStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    // body 在 multipart 中可能尚未解析，优先用 _uploadDir, 其次 query, 最后 body
    const dir = (req as any)._uploadDir || (req.query?.dir as string) || (req.body?.dir as string) || "uploads";
    const target = path.resolve(PUBLIC_DIR, dir);
    if (!target.startsWith(PUBLIC_DIR)) {
      cb(new Error("Invalid dir path"), "");
      return;
    }
    fs.mkdirSync(target, { recursive: true });
    cb(null, target);
  },
  filename: (req, file, cb) => {
    // 自定义名：?name=xxx（query）或 multipart 表单字段 name=xxx（需在 file 之前）
    const raw = (req.query?.name || (req as any).body?.name) as string | undefined;
    const custom = raw && typeof raw === "string" ? raw.trim() : "";
    const customBase = custom ? path.basename(custom).replace(/[\\/:*?"<>|]/g, "_") : "";

    // 扩展名优先级：自定义名自带 > 原文件名 > MIME 类型；确保最终一定有扩展名
    const rawExt = customBase ? path.extname(customBase).toLowerCase() : "";
    const customExt = /^\.[A-Za-z0-9]{1,10}$/.test(rawExt) ? rawExt : "";
    const base = customExt
      ? customBase.slice(0, customBase.length - customExt.length)
      : customBase || uuidv4();
    const ext = customExt || path.extname(file.originalname).toLowerCase() || MIME_EXT[file.mimetype] || "";

    const finalName = `${base}${ext}`;
    const target = path.join(
      (req as any)._uploadDir || (req.query?.dir as string) || (req.body?.dir as string) || "uploads",
      finalName
    );
    // 重名时追加短 uuid 避免覆盖
    if (fs.existsSync(path.resolve(PUBLIC_DIR, target))) {
      cb(null, `${base}-${uuidv4().slice(0, 8)}${ext}`);
      return;
    }
    cb(null, finalName);
  },
});

const fileUpload = multer({
  storage: fileStorage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// 解析音频 URL: 支持远程URL和本地文件
function resolveAudioUrl(audioUrl: string | undefined): string {
  if (!audioUrl) return "";
  if (audioUrl.startsWith("http://") || audioUrl.startsWith("https://")) {
    return audioUrl;
  }
  // 先查 public/audio/ 根目录，再查 public/audio/music/
  const localPath = path.join(AUDIO_DIR, audioUrl);
  if (fs.existsSync(localPath)) {
    return `${SERVER_URL}/audio/${audioUrl}`;
  }
  const musicPath = path.join(MUSIC_DIR, audioUrl);
  if (fs.existsSync(musicPath)) {
    return `${SERVER_URL}/audio/music/${audioUrl}`;
  }
  // 兜底：public/ 下任意位置的本地音频（如 video/av/xxx/audio.wav）
  const mediaPath = resolveLocalMediaPath(audioUrl);
  if (mediaPath) {
    const rel = path.relative(PUBLIC_DIR, mediaPath).split(path.sep).join("/");
    return `${SERVER_URL}/static/${rel}`;
  }
  console.warn(`Audio file not found: ${localPath}`);
  return "";
}

let bundleLocation: string | null = null;

// ========== 片段（图片/视频）解析 ==========
const FPS = 30;

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".avif", ".svg"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi"]);

/** 按扩展名推断片段类型，未知默认按图片处理 */
function inferMediaType(src: string): "image" | "video" {
  const ext = path.extname(src.split("?")[0]).toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "image";
}

/** 将 durationInFrames / durationSeconds 归一化为帧数；都未提供返回 undefined */
function toFrames(
  durationInFrames?: unknown,
  durationSeconds?: unknown,
  fps: number = FPS
): number | undefined {
  if (typeof durationInFrames === "number" && durationInFrames > 0) {
    return Math.round(durationInFrames);
  }
  if (typeof durationSeconds === "number" && durationSeconds > 0) {
    return Math.round(durationSeconds * fps);
  }
  return undefined;
}

/** 在 public/ 下解析本地素材绝对路径；远程地址、找不到或越界均返回 null */
function resolveLocalMediaPath(src: string): string | null {
  if (!src || /^https?:\/\//i.test(src)) return null;
  const cleaned = src.replace(/^\/?(?:static|public)\//i, "");
  const candidates = [
    path.resolve(PUBLIC_DIR, cleaned),
    path.resolve(PUBLIC_DIR, "uploads", cleaned),
    path.resolve(PUBLIC_DIR, "video", cleaned),
  ];
  for (const c of candidates) {
    if (isInside(PUBLIC_DIR, c) && fs.existsSync(c) && fs.statSync(c).isFile()) {
      return c;
    }
  }
  return null;
}

// 启动时打包 Remotion 项目
async function initBundle() {
  console.log("Bundling Remotion project...");
  bundleLocation = await bundle({
    entryPoint: path.resolve("./src/index.ts"),
    webpackOverride: (config) => config,
  });
  console.log(`Bundle ready: ${bundleLocation}`);
}

// ========== 统一文件上传 ==========
app.post("/api/files/upload", (req, res) => {
  fileUpload.single("file")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${err.message}` });
      } else {
        res.status(400).json({ error: err.message });
      }
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
      return;
    }

    const dir = ((req.body?.dir || req.query?.dir) as string) || "uploads";
    const relativePath = dir === "uploads" ? `uploads/${req.file.filename}` : `${dir}/${req.file.filename}`;

    // 复制到 bundle 目录
    if (bundleLocation) {
      const bundleTarget = path.resolve(bundleLocation, "public", dir);
      fs.mkdirSync(bundleTarget, { recursive: true });
      fs.copyFileSync(req.file.path, path.resolve(bundleTarget, req.file.filename));
    }

    res.json({
      success: true,
      file: {
        filename: relativePath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relativePath}`,
      },
    });
  });
});

// 旧端点兼容：重定向到新端点
app.post("/api/upload", (req, res) => {
  // 默认上传到 uploads 目录（用 _uploadDir 因为 multipart 中 body/query 不可写）
  (req as any)._uploadDir = "uploads";
  fileUpload.single("file")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${err.message}` });
      } else {
        res.status(400).json({ error: err.message });
      }
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
      return;
    }
    const relativePath = `uploads/${req.file.filename}`;
    if (bundleLocation) {
      const bundleTarget = path.resolve(bundleLocation, "public/uploads");
      fs.mkdirSync(bundleTarget, { recursive: true });
      fs.copyFileSync(req.file.path, path.resolve(bundleTarget, req.file.filename));
    }
    res.json({
      success: true,
      file: {
        filename: relativePath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relativePath}`,
      },
    });
  });
});

app.post("/api/audio/upload", (req, res) => {
  // 用 _uploadDir，multipart 中 body/query 均不可写
  (req as any)._uploadDir = "audio";
  fileUpload.single("file")(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        res.status(400).json({ error: `Upload error: ${err.message}` });
      } else {
        res.status(400).json({ error: err.message });
      }
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded. Use field name 'file'." });
      return;
    }
    const relativePath = req.file.filename;
    if (bundleLocation) {
      const bundleTarget = path.resolve(bundleLocation, "public/audio");
      fs.mkdirSync(bundleTarget, { recursive: true });
      fs.copyFileSync(req.file.path, path.resolve(bundleTarget, req.file.filename));
    }
    res.json({
      success: true,
      file: {
        filename: relativePath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/audio/${relativePath}`,
      },
    });
  });
});

// ========== 中转上传 ==========
// 两种模式：
// 1) 文件模式：传 filename（已上传到 public/ 下的文件路径），从磁盘读取并发给目标 URL（如 S3 presignedUrl）
// 2) 流模式：不传 filename，把请求体原始二进制流转发给目标 URL
// 目标 URL 通过 ?url= 查询参数或 X-Target-URL 请求头传入。
// 上游成功时返回对象访问 URL（去掉签名参数）和 ETag；失败时返回上游错误信息。
app.post("/api/relay-upload", (req, res) => {
  const target = (req.query.url as string) || (req.headers["x-target-url"] as string) || "";
  const fileName =
    (req.query.filename as string) || (req.headers["x-filename"] as string) || (req.body?.filename as string) || "";
  const contentType =
    (req.query.contentType as string) || (req.headers["content-type"] as string) || "application/octet-stream";
  const method = ((req.query.method as string) || (req.headers["x-target-method"] as string) || "PUT").toUpperCase();

  if (!target) {
    res.status(400).json({ error: "Missing target URL. Pass ?url= or X-Target-URL header." });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    res.status(400).json({ error: "Invalid target URL" });
    return;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    res.status(400).json({ error: "Only http/https target URLs are supported" });
    return;
  }

  const transport = parsed.protocol === "https:" ? https : http;
  const headers: Record<string, string> = { "Content-Type": contentType };
  let bodySource: NodeJS.ReadableStream;

  if (fileName) {
    // 文件模式：读取 public/ 下已上传的文件（兼容 public/audio/）
    let filePath = path.resolve(PUBLIC_DIR, fileName);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const audioPath = path.resolve(AUDIO_DIR, fileName);
      if (!audioPath.startsWith(AUDIO_DIR + path.sep) || !fs.existsSync(audioPath) || !fs.statSync(audioPath).isFile()) {
        res.status(404).json({ error: `File not found in public/: ${fileName}` });
        return;
      }
      filePath = audioPath;
    }
    headers["Content-Length"] = String(fs.statSync(filePath).size);
    bodySource = fs.createReadStream(filePath);
  } else {
    // 流模式：客户端已知大小时转发 Content-Length，避免上游（如 S3）拒绝 chunked 传输
    if (req.headers["content-length"]) {
      headers["Content-Length"] = req.headers["content-length"] as string;
    }
    bodySource = req;
  }

  const upstream = transport.request(parsed, { method, headers }, (upRes) => {
    const chunks: Buffer[] = [];
    upRes.on("data", (c: Buffer) => chunks.push(c));
    upRes.on("end", () => {
      const statusCode = upRes.statusCode || 502;
      const bodyText = Buffer.concat(chunks).toString("utf8").trim();
      const ok = statusCode >= 200 && statusCode < 300;
      const payload: Record<string, unknown> = { success: ok, statusCode };
      if (ok) {
        // 上游成功：返回对象访问 URL（去掉签名查询参数），如 COS/S3 的 https://bucket.cos.region.myqcloud.com/key
        payload.url = `${parsed.origin}${parsed.pathname}`;
        if (upRes.headers["etag"]) payload.etag = upRes.headers["etag"] as string;
      } else if (bodyText) {
        payload.error = bodyText.length > 2000 ? `${bodyText.slice(0, 2000)}...` : bodyText;
      }
      res.status(statusCode).json(payload);
    });
  });

  upstream.on("error", (e) => {
    console.error("Relay upload upstream error:", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: `Upstream error: ${e.message}` });
    } else {
      res.destroy();
    }
  });

  bodySource.on("error", (e) => upstream.destroy(e));
  bodySource.pipe(upstream);
});

// ========== 统一文件列表 ==========
app.get("/api/files", (req, res) => {
  const dir = (req.query.dir || "uploads") as string;
  const target = path.resolve(PUBLIC_DIR, dir);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.status(400).json({ error: "Invalid dir" });
    return;
  }
  try {
    fs.mkdirSync(target, { recursive: true });
    const files = fs.readdirSync(target, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => ({
        filename: dir === "uploads" ? `uploads/${f.name}` : `${dir}/${f.name}`,
        name: f.name,
        url: `/static/${dir}/${f.name}`,
        size: fs.statSync(path.join(target, f.name)).size,
      }));
    res.json({ dir, files });
  } catch {
    res.json({ dir, files: [] });
  }
});

// GET /api/uploads - 旧端点兼容
app.get("/api/uploads", (_req, res) => {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const files = fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => ({
        filename: `uploads/${f.name}`,
        name: f.name,
        url: `/static/uploads/${f.name}`,
      }));
    res.json({ files });
  } catch {
    res.json({ files: [] });
  }
});

// ========== 统一文件删除 ==========
app.post("/api/files/delete", (req, res) => {
  const { files, dir } = req.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "files must be a non-empty array" });
    return;
  }

  const results: { filename: string; deleted: boolean; error?: string }[] = [];

  for (const f of files) {
    if (typeof f !== "string" || f.trim().length === 0) {
      results.push({ filename: String(f), deleted: false, error: "Invalid filename" });
      continue;
    }

    // 确定目录和文件名
    let fileSubDir: string;
    let name: string;
    const hasPath = f.includes("/");

    if (dir) {
      // 显式指定目录，从完整路径中提取纯文件名
      name = path.basename(f);
      fileSubDir = dir;
    } else if (hasPath) {
      // 从文件路径中提取目录
      const parts = f.split("/");
      name = parts.pop()!;
      fileSubDir = parts.join("/") || "uploads";
    } else {
      // 纯文件名，默认 uploads
      name = f;
      fileSubDir = "uploads";
    }

    const targetDir = path.resolve(PUBLIC_DIR, fileSubDir);
    if (!targetDir.startsWith(PUBLIC_DIR)) {
      results.push({ filename: f, deleted: false, error: "Invalid dir" });
      continue;
    }

    const filePath = path.resolve(targetDir, name);
    if (!filePath.startsWith(targetDir)) {
      results.push({ filename: f, deleted: false, error: "Invalid path" });
      continue;
    }

    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      // 同步删除 bundle 目录中的文件
      if (bundleLocation) {
        const bundlePath = path.resolve(bundleLocation, "public", fileSubDir, name);
        if (fs.existsSync(bundlePath)) fs.unlinkSync(bundlePath);
      }
      results.push({ filename: f, deleted: true });
    } catch (err) {
      results.push({
        filename: f,
        deleted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.json({ success: true, results });
});

// POST /api/uploads/delete - 旧端点兼容
app.post("/api/uploads/delete", (req, res) => {
  const { files } = req.body;

  if (!files || !Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "files must be a non-empty array" });
    return;
  }

  const results: { filename: string; deleted: boolean; error?: string }[] = [];

  for (const f of files) {
    const name = typeof f === "string" && f.startsWith("uploads/") ? f.slice(8) : f;
    const filePath = path.resolve(UPLOAD_DIR, path.basename(name));

    if (!filePath.startsWith(UPLOAD_DIR)) {
      results.push({ filename: f, deleted: false, error: "Invalid path" });
      continue;
    }

    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (bundleLocation) {
        const bundlePath = path.resolve(bundleLocation, "public/uploads", path.basename(name));
        if (fs.existsSync(bundlePath)) fs.unlinkSync(bundlePath);
      }
      results.push({ filename: f, deleted: true });
    } catch (err) {
      results.push({
        filename: f,
        deleted: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  res.json({ success: true, results });
});

// ========== 压缩图片 ==========
const compressUpload = multer({
  storage: fileStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post("/api/images/compress", (req, res) => {
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    // 上传新文件压缩
    compressUpload.single("file")(req, res, (err) => {
      if (err) {
        res.status(400).json({ error: err.message });
        return;
      }
      doCompress(req, res);
    });
  } else {
    // JSON body：压缩已有文件
    doCompress(req, res);
  }
});

async function doCompress(req: express.Request, res: express.Response) {
  try {
    const sharp = (await import("sharp")).default;
    const quality = Math.min(100, Math.max(1, parseInt(String(req.body.quality)) || 80));
    const maxWidth = req.body.maxWidth ? parseInt(String(req.body.maxWidth)) : undefined;
    const maxHeight = req.body.maxHeight ? parseInt(String(req.body.maxHeight)) : undefined;

    let inputPath: string;
    let isExisting = false;

    if (req.file) {
      inputPath = req.file.path;
    } else if (req.body.filename && typeof req.body.filename === "string") {
      const name = req.body.filename.startsWith("uploads/")
        ? req.body.filename.slice(8)
        : req.body.filename;
      inputPath = path.resolve(UPLOAD_DIR, name);
      if (!inputPath.startsWith(UPLOAD_DIR) || !fs.existsSync(inputPath)) {
        res.status(400).json({ error: `File not found: ${req.body.filename}` });
        return;
      }
      isExisting = true;
    } else {
      res.status(400).json({ error: "Provide 'file' (upload) or 'filename' (existing file)" });
      return;
    }

    const outName = `${uuidv4()}.jpg`;
    const outputPath = path.resolve(UPLOAD_DIR, outName);

    let pipeline = sharp(inputPath).jpeg({ quality, mozjpeg: true });

    if (maxWidth || maxHeight) {
      pipeline = pipeline.resize({
        width: maxWidth,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      });
    }

    await pipeline.toFile(outputPath);
    const metadata = await sharp(outputPath).metadata();

    // 复制到 bundle 目录
    if (bundleLocation) {
      const bundleUploadDir = path.resolve(bundleLocation, "public/uploads");
      fs.mkdirSync(bundleUploadDir, { recursive: true });
      fs.copyFileSync(outputPath, path.resolve(bundleUploadDir, outName));
    }

    const stats = fs.statSync(outputPath);
    const originalSize = isExisting ? fs.statSync(inputPath).size : req.file!.size;

    res.json({
      success: true,
      file: {
        filename: `uploads/${outName}`,
        url: `/static/uploads/${outName}`,
        sizeBytes: stats.size,
        originalSizeBytes: originalSize,
        compressionRatio: Math.round((1 - stats.size / originalSize) * 100),
        width: metadata.width,
        height: metadata.height,
        format: "jpeg",
        quality,
      },
    });
  } catch (e) {
    console.error("Compress error:", e);
    res.status(500).json({
      error: "Compress failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

// ========== 渲染视频 ==========
app.post("/api/render", async (req, res) => {
  try {
    const {
      images,
      slides,
      audioUrl,
      audioTracks,
      durationPerImage,
      transition,
      transitionDuration,
      camera,
    } = req.body;

    if (!bundleLocation) {
      res.status(500).json({ error: "Bundle not initialized yet" });
      return;
    }

    // 校验：images 或 slides 至少有一个且非空
    const hasSlides = slides && Array.isArray(slides) && slides.length > 0;
    const hasImages = images && Array.isArray(images) && images.length > 0;

    if (!hasSlides && !hasImages) {
      res.status(400).json({
        error: "Either 'images' or 'slides' must be a non-empty array",
      });
      return;
    }

    // 构建 inputProps
    const inputProps: Record<string, unknown> = {
      durationPerImage: durationPerImage || 90,
    };

    // 高级模式: slides（图片/视频混排，支持每段独立时长）
    const warnings: string[] = [];
    let slidesResolved: Record<string, unknown>[] | null = null;
    // 成片基准：默认 1280x720@30；若含视频，则以第一段视频的帧率与分辨率为准
    let outputFps = FPS;
    let outputWidth = 1280;
    let outputHeight = 720;

    if (hasSlides) {
      const rawSlides = (slides as Record<string, unknown>[]).filter(
        (s) => typeof s?.src === "string" && String(s.src).trim().length > 0
      );
      if (rawSlides.length === 0) {
        res.status(400).json({ error: "slides must contain non-empty src values" });
        return;
      }

      // 第一遍：归一化每段类型，并探测视频素材信息
      const probed: Array<{
        src: string;
        type: "image" | "video";
        raw: Record<string, unknown>;
        localPath?: string;
        info?: { width: number; height: number; duration: number; fps: number } | null;
      }> = [];
      for (const s of rawSlides) {
        const src = String(s.src).trim();
        const declared = s.type === "video" || s.type === "image" ? s.type : undefined;
        const type = declared ?? inferMediaType(src);
        if (type === "video") {
          const localPath = resolveLocalMediaPath(src);
          if (!localPath) {
            res.status(400).json({ error: `Video not found: ${src}` });
            return;
          }
          const info = await getVideoInfo(localPath);
          if (!info || info.duration <= 0) {
            res.status(400).json({ error: `Cannot read video duration: ${src}` });
            return;
          }
          probed.push({ src, type, raw: s, localPath, info });
        } else {
          probed.push({ src, type, raw: s });
        }
      }

      // 以第一段视频为基准设定成片帧率与画布尺寸（比例不一致时由 contain 留黑边）
      const firstVideo = probed.find((p) => p.type === "video" && p.info);
      if (firstVideo?.info) {
        const f = Math.round(firstVideo.info.fps);
        if (Number.isFinite(f) && f > 0) outputFps = Math.min(f, 120);
        if (firstVideo.info.width > 0) outputWidth = firstVideo.info.width;
        if (firstVideo.info.height > 0) outputHeight = firstVideo.info.height;
      }

      // 第二遍：按成片帧率换算时长/素材帧数
      const resolved: Record<string, unknown>[] = [];
      for (let i = 0; i < probed.length; i++) {
        const p = probed[i];
        const s = p.raw;
        if (p.type === "video" && p.info) {
          const frames = toFrames(s.durationInFrames, s.durationSeconds, outputFps);
          const trimStartSeconds =
            typeof s.trimStartSeconds === "number" && s.trimStartSeconds > 0
              ? s.trimStartSeconds
              : 0;
          const availableSeconds = Math.max(0, p.info.duration - trimStartSeconds);
          const sourceFrames = Math.floor(availableSeconds * outputFps);
          // 未指定时长 => 播完素材；指定时长超出素材 => 超出部分以黑帧补足
          const durationInFrames = Math.max(1, frames ?? sourceFrames);
          if (durationInFrames > sourceFrames) {
            warnings.push(
              `slides[${i}] ${p.src}: 素材可用 ${sourceFrames} 帧，超出部分 ${
                durationInFrames - sourceFrames
              } 帧以黑帧补足`
            );
          }

          // 走 express 静态路由，避免 bundle 快照不包含运行时新增的文件
          const relPath = path.relative(PUBLIC_DIR, p.localPath!).split(path.sep).join("/");
          resolved.push({
            src: `${SERVER_URL}/static/${relPath}`,
            type: "video",
            durationInFrames,
            sourceFrames,
            trimStartSeconds,
            volume: typeof s.volume === "number" ? s.volume : 0,
          });
        } else {
          const frames = toFrames(s.durationInFrames, s.durationSeconds, outputFps);
          resolved.push({
            src: p.src,
            type: "image",
            durationInFrames: Math.max(1, frames ?? (durationPerImage || 90)),
            camera: s.camera || undefined,
          });
        }
      }

      inputProps.slides = resolved;
      slidesResolved = resolved;
    } else {
      // 简单模式: images (string[])
      inputProps.images = images.filter(
        (src: string) => typeof src === "string" && src.trim().length > 0
      );
    }

    // 成片帧率与画布尺寸：由 calculateMetadata 生效
    inputProps.fps = outputFps;
    inputProps.width = outputWidth;
    inputProps.height = outputHeight;

    // 转场参数
    if (transition && ["fade", "slide", "wipe", "none"].includes(transition)) {
      inputProps.transition = transition;
    }
    if (typeof transitionDuration === "number") {
      inputProps.transitionDuration = transitionDuration;
    }

    // 全局运镜（会被 slides 中每张图的 camera 覆盖）
    if (camera) {
      inputProps.camera = camera;
    }

    // 音频
    if (audioTracks && Array.isArray(audioTracks) && audioTracks.length > 0) {
      const validTracks = audioTracks
        .map(
          (t: { src?: string; volume?: number; startFrom?: number }) => ({
            src: resolveAudioUrl(t.src) || "",
            volume: t.volume ?? 1,
            startFrom: t.startFrom ?? 0,
          })
        )
        .filter((t: { src: string }) => t.src.length > 0);
      if (validTracks.length > 0) {
        inputProps.audioTracks = validTracks;
      } else {
        // 所有音轨都无效时，回退到单音频模式
        inputProps.audioUrl = resolveAudioUrl(audioUrl);
      }
    } else {
      inputProps.audioUrl = resolveAudioUrl(audioUrl);
    }

    const compositionId = "SlideVideo";

    console.log("Selecting composition...");
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: compositionId,
      inputProps,
    });
    console.log(`Composition selected: ${composition.durationInFrames} frames`);

    const outputFileName = `video-${uuidv4()}.mp4`;
    const relFile = path.posix.join("video", "render", outputFileName);
    const outputDir = path.resolve(PUBLIC_DIR, "video", "render");
    fs.mkdirSync(outputDir, { recursive: true });
    const outputLocation = path.resolve(outputDir, outputFileName);

    console.log(`Rendering to: ${outputLocation}`);
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation,
      inputProps,
      chromiumOptions: {
        disableWebSecurity: true,
      },
    });

    console.log("Render complete!");
    const stats = fs.statSync(outputLocation);

    res.json({
      success: true,
      output: {
        filename: relFile,
        path: outputLocation,
        url: `/static/${relFile}`,
        sizeBytes: stats.size,
        durationInFrames: composition.durationInFrames,
        fps: composition.fps,
      },
      slidesResolved,
      warnings,
    });
  } catch (err) {
    console.error("Render error:", err);
    res.status(500).json({
      error: "Render failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ========== 音频 + 字幕插入视频 ==========
// 按时间段把对应的 TTS 音频与字幕叠加到原视频上：原视频整段铺底并保留原声，
// 每条音频与其字幕绑定在同一个 Sequence 中（起点/时长一致，天然对齐）。
// 排程规则：
//   1) 顺延：每段起点取 max(输入 start, 上一段结束)，音频时长超出输入区间时自然后推；
//   2) 溢出微调：若整体超出视频时长，按段间空隙比例向前收拢（视频与音频都不裁剪），
//      利用空隙把内容塞回视频时长内，保持音频与字幕对齐。
const INSERT_MIN = 1e-6;

/** 探测媒体时长（秒），失败返回 0 */
async function getMediaDuration(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ["-v", "quiet", "-print_format", "json", "-show_format", filePath],
      (err, stdout) => {
        if (err) { resolve(0); return; }
        try {
          const data = JSON.parse(stdout);
          const d = parseFloat(data.format?.duration || "0");
          resolve(Number.isFinite(d) ? d : 0);
        } catch { resolve(0); }
      }
    );
  });
}

/** 根据音频实际时长计算各段最终 start/end（秒）；items 已按 start 升序 */
function planInsertSchedule(
  items: { start: number; dur: number }[],
  videoDuration: number
): { start: number; end: number }[] {
  const n = items.length;
  if (n === 0) return [];

  // 1) 正向顺延：起点不早于输入 start，也不早于上一段结束
  const starts: number[] = new Array(n);
  let prevEnd = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, items[i].start, prevEnd);
    starts[i] = s;
    prevEnd = s + items[i].dur;
  }

  const naturalEnd = prevEnd;
  const totalAudio = items.reduce((sum, it) => sum + it.dur, 0);
  const overflow = naturalEnd - videoDuration;

  if (overflow > INSERT_MIN && videoDuration > 0) {
    // 2) 按空隙比例向前收拢；空隙不足以抵消（音频总长已超视频）时改为紧密排列
    const totalGaps = naturalEnd - totalAudio;
    const factor =
      totalGaps > INSERT_MIN && totalAudio <= videoDuration
        ? Math.min(1, overflow / totalGaps)
        : 1;

    const gaps: number[] = new Array(n);
    gaps[0] = starts[0];
    for (let i = 1; i < n; i++) {
      gaps[i] = starts[i] - (starts[i - 1] + items[i - 1].dur);
    }
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const s = cursor + gaps[i] * (1 - factor);
      starts[i] = s;
      cursor = s + items[i].dur;
    }
  }

  return starts.map((s, i) => ({
    start: Math.round(s * 1000) / 1000,
    end: Math.round((s + items[i].dur) * 1000) / 1000,
  }));
}

app.post("/api/video/insert", (req, res) => {
  const handle = async (videoPath: string, sourceInfo: Record<string, unknown>) => {
    try {
      if (!bundleLocation) {
        res.status(500).json({ success: false, error: "Bundle not initialized yet" });
        return;
      }

      // ---- 解析 segments（支持 JSON 字符串） ----
      const raw = (req.body || {}).segments;
      let segmentsRaw: unknown = raw;
      if (typeof raw === "string") {
        try { segmentsRaw = JSON.parse(raw); } catch { segmentsRaw = null; }
      }
      if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) {
        res.status(400).json({ success: false, error: "segments must be a non-empty array" });
        return;
      }

      const info = await getVideoInfo(videoPath);
      if (!info || info.duration <= 0) {
        res.status(400).json({ success: false, error: "Cannot read source video duration" });
        return;
      }
      const videoDuration = info.duration;
      const outFps = info.fps && info.fps > 0 ? Math.min(Math.round(info.fps), 120) : FPS;
      const outWidth = info.width > 0 ? info.width : 1280;
      const outHeight = info.height > 0 ? info.height : 720;

      // ---- 逐段解析音频并探测实际时长 ----
      const parsed: {
        index: number;
        text: string;
        nominalStart: number;
        nominalEnd: number;
        dur: number;
        audioFilename: string;
        audioUrl: string;
      }[] = [];

      for (let i = 0; i < segmentsRaw.length; i++) {
        const s = (segmentsRaw[i] || {}) as Record<string, unknown>;
        const index = Number.isFinite(Number(s.index)) ? Number(s.index) : i;
        const nominalStart = numOpt(s.start, NaN);
        if (!Number.isFinite(nominalStart)) {
          res.status(400).json({ success: false, error: `Segment ${i}: 'start' is required` });
          return;
        }
        const nominalEnd = numOpt(s.end, nominalStart + 1);
        const text = typeof s.text === "string" ? s.text : "";

        // 音频来源：filename 优先，其次 url
        const audioRef =
          (typeof s.filename === "string" && s.filename) ||
          (typeof s.url === "string" && s.url) || "";
        if (!audioRef) {
          res.status(400).json({ success: false, error: `Segment ${i}: 'filename' or 'url' is required` });
          return;
        }
        const audioLocal = resolveLocalMediaPath(audioRef);
        if (!audioLocal) {
          res.status(404).json({ success: false, error: `Segment ${i}: audio not found: ${audioRef}` });
          return;
        }
        const dur = await getMediaDuration(audioLocal);
        if (!(dur > 0)) {
          res.status(400).json({ success: false, error: `Segment ${i}: cannot read audio duration: ${audioRef}` });
          return;
        }
        const relAudio = path.relative(PUBLIC_DIR, audioLocal).split(path.sep).join("/");
        parsed.push({
          index,
          text,
          nominalStart: Math.max(0, nominalStart),
          nominalEnd: Math.max(0, nominalEnd),
          dur,
          audioFilename: relAudio,
          audioUrl: `${SERVER_URL}/static/${relAudio}`,
        });
      }

      // 按 start 稳定排序后统一排程
      const order = parsed
        .map((p, i) => ({ p, i }))
        .sort((a, b) => a.p.nominalStart - b.p.nominalStart || a.i - b.i);

      const planned = planInsertSchedule(
        order.map((o) => ({ start: o.p.nominalStart, dur: o.p.dur })),
        videoDuration
      );

      const warnings: string[] = [];
      let contentEnd = 0;
      const outSegments = order.map((o, i) => {
        const { start, end } = planned[i];
        contentEnd = Math.max(contentEnd, end);
        return {
          index: o.p.index,
          text: o.p.text,
          start,
          end,
          audioDuration: Math.round(o.p.dur * 1000) / 1000,
          nominalStart: o.p.nominalStart,
          nominalEnd: o.p.nominalEnd,
          audio: {
            filename: o.p.audioFilename,
            url: `/static/${o.p.audioFilename}`,
          },
        };
      });

      if (contentEnd > videoDuration + INSERT_MIN) {
        warnings.push(
          `内容总时长 ${contentEnd.toFixed(2)}s 超出视频时长 ${videoDuration.toFixed(2)}s，` +
            `末尾 ${(contentEnd - videoDuration).toFixed(2)}s 将超出画面被截断`
        );
      }
      const shiftedCount = outSegments.filter(
        (s, i) => Math.abs(s.start - order[i].p.nominalStart) > 0.01
      ).length;
      if (shiftedCount > 0) {
        warnings.push(`共 ${shiftedCount} 段起点发生顺延/前移（见 segments 中的最终 start）`);
      }

      // ---- 底图视频地址（走静态路由，避免 bundle 快照缺失运行时文件） ----
      const relVideo = path.relative(PUBLIC_DIR, videoPath).split(path.sep).join("/");

      const inputProps: Record<string, unknown> = {
        videoSrc: `${SERVER_URL}/static/${relVideo}`,
        segments: order.map((o, i) => ({
          index: o.p.index,
          start: planned[i].start,
          end: planned[i].end,
          audioSrc: o.p.audioUrl,
          text: o.p.text,
        })),
        videoVolume: numOpt(req.body?.videoVolume, 1),
        ttsVolume: numOpt(req.body?.ttsVolume, 1),
        subtitle: {
          fontSize: Number.isFinite(Number(req.body?.fontSize)) ? Number(req.body.fontSize) : undefined,
          color: typeof req.body?.fontColor === "string" ? req.body.fontColor : undefined,
          backgroundColor:
            typeof req.body?.subtitleBackground === "string" ? req.body.subtitleBackground : undefined,
          position: ["bottom", "top", "center"].includes(req.body?.subtitlePosition)
            ? req.body.subtitlePosition
            : undefined,
        },
        fps: outFps,
        width: outWidth,
        height: outHeight,
        durationInFrames: Math.max(1, Math.round(videoDuration * outFps)),
      };

      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: "AudioSubtitleVideo",
        inputProps,
      });

      const jobId = uuidv4();
      const relDir = path.posix.join("video", "insert", jobId);
      const outDir = path.resolve(PUBLIC_DIR, relDir);
      fs.mkdirSync(outDir, { recursive: true });
      const outName = "output.mp4";
      const outPath = path.resolve(outDir, outName);

      await renderMedia({
        composition,
        serveUrl: bundleLocation,
        codec: "h264",
        outputLocation: outPath,
        inputProps,
        chromiumOptions: { disableWebSecurity: true },
      });

      const stats = fs.statSync(outPath);
      res.json({
        success: true,
        source: {
          ...sourceInfo,
          duration: videoDuration,
          fps: outFps,
          width: outWidth,
          height: outHeight,
        },
        output: {
          filename: `${relDir}/${outName}`,
          url: `/static/${relDir}/${outName}`,
          sizeBytes: stats.size,
          durationInFrames: composition.durationInFrames,
          fps: composition.fps,
          width: composition.width,
          height: composition.height,
        },
        segments: outSegments,
        warnings,
      });
    } catch (e) {
      console.error("Video insert error:", e);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      handle(req.file.path, { filename: relPath, originalName: req.file.originalname, size: req.file.size });
    });
    return;
  }

  const filename = req.body?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  handle(localPath, { filename });
});

// ========== 列出音乐（audio/music 目录） ==========
app.get("/api/audio", (_req, res) => {
  try {
    fs.mkdirSync(MUSIC_DIR, { recursive: true });
    const files = fs.readdirSync(MUSIC_DIR, { withFileTypes: true })
      .filter((f) => f.isFile())
      .map((f) => ({
        filename: f.name,
        url: `/audio/music/${f.name}`,
      }));
    res.json({ files });
  } catch {
    res.json({ files: [] });
  }
});

// ========== 串联音频 ==========
app.post("/api/audio/concat", (req, res) => {
  const { files, outputName } = req.body;

  if (!files || !Array.isArray(files) || files.length < 2) {
    res.status(400).json({ error: "files must be an array with at least 2 filenames" });
    return;
  }

  // 安全检查：所有输入文件必须在 AUDIO_DIR 内（支持 audio/<taskId>/001.wav 子路径）
  const inputPaths: string[] = [];
  for (const f of files) {
    const raw = typeof f === "string" ? f.replace(/\\/g, "/").replace(/^\/+/, "") : "";
    const rel = raw.startsWith("audio/") ? raw.slice("audio/".length) : raw;
    let fp = path.resolve(AUDIO_DIR, rel);
    if (!fp.startsWith(AUDIO_DIR + path.sep)) {
      // 兜底：仅取文件名（兼容旧调用）
      fp = path.resolve(AUDIO_DIR, path.basename(rel));
    }
    if (!fp.startsWith(AUDIO_DIR + path.sep) || !fs.existsSync(fp)) {
      res.status(404).json({ error: `File not found: ${f}` });
      return;
    }
    inputPaths.push(fp);
  }

  // 输出文件名
  const outName = outputName && typeof outputName === "string"
    ? `${uuidv4()}_${path.basename(outputName)}`
    : `${uuidv4()}_concat.mp3`;
  const outputPath = path.resolve(AUDIO_DIR, outName);

  // 构建 ffmpeg 命令: concat filter
  // ffmpeg -i f1.mp3 -i f2.mp3 ... -filter_complex "[0:a][1:a]...concat=n=N:v=0:a=1" -ac 2 output.mp3
  const inputs = inputPaths.flatMap((p) => ["-i", p]);
  const filterInputs = inputPaths.map((_, i) => `[${i}:a]`).join("");
  const filterStr = `${filterInputs}concat=n=${inputPaths.length}:v=0:a=1`;

  console.log(`Concatenating ${inputPaths.length} audio files -> ${outName}`);

  execFile(
    FFMPEG,
    [
      ...inputs,
      "-filter_complex", filterStr,
      "-ac", "2",
      "-y",
      outputPath,
    ],
    (err) => {
      if (err) {
        console.error("ffmpeg concat error:", err);
        res.status(500).json({ error: "Failed to concatenate audio", detail: err.message });
        return;
      }

      // 复制到 bundle 目录
      if (bundleLocation) {
        const bundleAudioDir = path.resolve(bundleLocation, "public/audio");
        fs.mkdirSync(bundleAudioDir, { recursive: true });
        fs.copyFileSync(outputPath, path.resolve(bundleAudioDir, outName));
      }

      // 用 ffprobe 获取合并后的时长
      execFile(
        FFPROBE,
        ["-v", "quiet", "-show_entries", "format=duration", "-of", "csv=p=0", outputPath],
        (_err2, stdout) => {
          res.json({
            success: true,
            file: {
              filename: outName,
              originalFiles: files,
              size: fs.statSync(outputPath).size,
              durationInSeconds: parseFloat(stdout.trim()) || 0,
              url: `/audio/${outName}`,
            },
          });
        }
      );
    }
  );
});

// ========== 获取音频时长 ==========
app.get("/api/audio/:filename/duration", (req, res) => {
  const { filename } = req.params;

  // 安全检查：防止路径穿越
  const filePath = path.resolve(AUDIO_DIR, filename);
  if (!filePath.startsWith(AUDIO_DIR)) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: `Audio file not found: ${filename}` });
    return;
  }

  // 使用 ffprobe 获取音频时长
  execFile(
    FFPROBE,
    [
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ],
    (err, stdout) => {
      if (err) {
        console.error("ffprobe error:", err);
        res.status(500).json({ error: "Failed to get audio duration" });
        return;
      }

      const durationInSeconds = parseFloat(stdout.trim());
      res.json({
        filename,
        durationInSeconds: isNaN(durationInSeconds) ? 0 : durationInSeconds,
        size: fs.statSync(filePath).size,
      });
    }
  );
});

// ========== 音频智能切分（新奇度检测 + DSP） ==========
// 流程：ffmpeg 解码 -> 纯 Node 实现 STFT / 谱通量(spectral flux)新奇度曲线 + 静音检测
//      -> 规划切点（每段 <= maxDuration，优先贴近 maxDuration，其次落在静音/段落变化处）
//      -> 按样本号精确切割为 WAV（无损、样本守恒，拼接后与源音频完全一致）
// 精度：WAV 最小量化单位为 1 个样本（44.1kHz 下约 0.0000227s），远优于 0.01s

class SplitError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// 执行外部命令并返回 stdout 文本
function runText(cmd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout));
    });
  });
}

// 迭代式 radix-2 FFT（原地）
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k;
        const b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// 5 点中值滤波（去除新奇度曲线毛刺）
function medianFilter5(input: Float64Array): Float64Array {
  const n = input.length;
  const out = new Float64Array(n);
  const buf = new Array<number>(5);
  for (let i = 0; i < n; i++) {
    let c = 0;
    for (let k = -2; k <= 2; k++) {
      const idx = i + k;
      buf[c++] = idx >= 0 && idx < n ? input[idx] : 0;
    }
    buf.sort((a, b) => a - b);
    out[i] = buf[2];
  }
  return out;
}

interface AudioFeatures {
  frameRate: number;      // 每秒帧数 = sampleRate / hop
  novelty: Float64Array;  // 归一化新奇度曲线 [0,1]
  rms: Float64Array;      // 每帧 RMS（用于静音检测）
}

// STFT + 谱通量新奇度 + 帧 RMS
function extractFeatures(mono: Float32Array, sampleRate: number): AudioFeatures {
  const nFft = 2048;
  const hop = 512;
  const binCount = nFft / 2 + 1;
  const frameCount = mono.length >= nFft ? Math.floor((mono.length - nFft) / hop) + 1 : 0;
  const frameRate = sampleRate / hop;

  const win = new Float64Array(nFft);
  for (let i = 0; i < nFft; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nFft - 1));

  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  const prev = new Float64Array(binCount);
  const novelty = new Float64Array(frameCount);
  const rms = new Float64Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const off = f * hop;
    let sumSq = 0;
    for (let i = 0; i < nFft; i++) {
      const s = mono[off + i];
      sumSq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sumSq / nFft);

    fftInPlace(re, im);

    let flux = 0;
    for (let k = 0; k < binCount; k++) {
      const mag = Math.log(1 + Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      const d = mag - prev[k];
      if (d > 0) flux += d;
      prev[k] = mag;
    }
    novelty[f] = flux;
  }

  // 两次中值滤波去毛刺，再归一化到 [0,1]
  const smoothed = medianFilter5(medianFilter5(novelty));
  let max = 0;
  for (let i = 0; i < smoothed.length; i++) if (smoothed[i] > max) max = smoothed[i];
  if (max > 0) for (let i = 0; i < smoothed.length; i++) smoothed[i] /= max;

  return { frameRate, novelty: smoothed, rms };
}

interface SplitCandidate {
  time: number;
  score: number;                       // 0~1，越大越适合切
  source: "silence" | "novelty";
}

// 候选切点 = 静音中点（高优先）+ 新奇度峰值
function pickCandidates(feat: AudioFeatures, sensitivity: number, minSilence: number): SplitCandidate[] {
  const { novelty, rms, frameRate } = feat;
  const n = novelty.length;
  const cands: SplitCandidate[] = [];

  // 1) 静音段中点：自适应阈值 = max(噪声底 x2, 峰值 x2%)
  const sortedRms = Float64Array.from(rms).sort();
  const noiseFloor = sortedRms.length ? sortedRms[Math.floor(sortedRms.length * 0.2)] : 0;
  let peakRms = 0;
  for (let i = 0; i < rms.length; i++) if (rms[i] > peakRms) peakRms = rms[i];
  const silenceThreshold = Math.max(noiseFloor * 2, peakRms * 0.02, 1e-6);
  const minSilenceFrames = Math.max(1, Math.round(minSilence * frameRate));

  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const isSilent = i < n && rms[i] < silenceThreshold;
    if (isSilent) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart >= minSilenceFrames) {
        cands.push({ time: (runStart + i - 1) / 2 / frameRate, score: 1, source: "silence" });
      }
      runStart = -1;
    }
  }

  // 2) 新奇度峰值：局部极大 + 自适应阈值
  let sum = 0;
  for (let i = 0; i < n; i++) sum += novelty[i];
  const mean = n ? sum / n : 0;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (novelty[i] - mean) * (novelty[i] - mean);
  const std = n ? Math.sqrt(varSum / n) : 0;
  const threshold = mean + sensitivity * std;

  for (let i = 1; i < n - 1; i++) {
    const v = novelty[i];
    if (v < threshold) continue;
    if (!(v >= novelty[i - 1] && v > novelty[i + 1])) continue;
    cands.push({ time: i / frameRate, score: v, source: "novelty" });
  }

  // 按时间排序并去重（间隔 < 0.3s 保留得分更高者）
  cands.sort((a, b) => a.time - b.time);
  const merged: SplitCandidate[] = [];
  for (const c of cands) {
    const last = merged[merged.length - 1];
    if (last && c.time - last.time < 0.3) {
      if (c.score > last.score) merged[merged.length - 1] = c;
      continue;
    }
    merged.push(c);
  }
  return merged;
}

// 规划切点（秒）：每段 <= maxDuration。
// 在 [maxDuration - tolerance, maxDuration] 窗口内寻找候选切点：
//   cost = wTime * 归一化时间代价 + (1 - score)
// 得分（静音/自然停顿）占主导，因此窗口内的高分候选可适度比 maxDuration 提前；
// 窗口内无候选则硬切 maxDuration（绝不超时）。
function planBoundaries(
  candidates: SplitCandidate[],
  totalDuration: number,
  maxDuration: number,
  minDuration: number,
  tolerance: number
): number[] {
  const EPS = 1e-6;
  const wTime = 0.5; // 时间代价权重（<1：得分主导，但越接近 maxDuration 越优）
  const boundaries: number[] = [0];
  let cursor = 0;

  while (totalDuration - cursor > maxDuration + EPS) {
    const lo = Math.max(cursor + minDuration, cursor + maxDuration - tolerance);
    const hi = cursor + maxDuration + EPS;
    const span = Math.max(EPS, tolerance); // 归一化分母
    let bestTime = cursor + maxDuration;   // 兜底：硬切，绝不超时
    let bestCost = 1;                      // 硬切代价（时间代价 0 + 得分 0 的 (1-score)）
    for (const c of candidates) {
      if (c.time < lo || c.time > hi) continue;
      const timeCost = (maxDuration - (c.time - cursor)) / span; // 窗口内约 [0,1]
      const cost = wTime * timeCost + (1 - c.score);
      if (cost < bestCost) {
        bestCost = cost;
        bestTime = c.time;
      }
    }
    boundaries.push(bestTime);
    cursor = bestTime;
  }
  boundaries.push(totalDuration);

  // 尾部碎片处理：末段过短时把最后两段重新均分（保证不超 maxDuration）
  const n = boundaries.length;
  if (n >= 3 && boundaries[n - 1] - boundaries[n - 2] < minDuration) {
    const start = boundaries[n - 3];
    const half = (boundaries[n - 1] - start) / 2;
    if (half >= minDuration && half <= maxDuration) boundaries[n - 2] = start + half;
  }

  return boundaries;
}

// 读取 WAV 的 data chunk 得到样本数（比 ffprobe 估算更精确）
function wavDataSamples(filePath: string, channels: number, bytesPerSample = 2): number {
  const fd = fs.openSync(filePath, "r");
  try {
    const header = Buffer.alloc(4096);
    const read = fs.readSync(fd, header, 0, header.length, 0);
    let pos = 12; // 跳过 RIFF....WAVE
    while (pos + 8 <= read) {
      const id = header.toString("ascii", pos, pos + 4);
      const size = header.readUInt32LE(pos + 4);
      if (id === "data") return Math.floor(size / (channels * bytesPerSample));
      pos += 8 + size + (size % 2);
    }
  } finally {
    fs.closeSync(fd);
  }
  return 0;
}

// 读取单声道 pcm_s16le WAV 为 [-1,1] 浮点样本（供 DSP 使用）
function readMonoWavFloat(filePath: string): Float32Array {
  const buf = fs.readFileSync(filePath);
  let pos = 12; // 跳过 RIFF....WAVE
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "data") {
      const frames = Math.floor(size / 2);
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(pos + 8 + i * 2) / 32768;
      return out;
    }
    pos += 8 + size + (size % 2);
  }
  return new Float32Array(0);
}

// 按样本号切出全部片段（PCM WAV，样本级精确）
// 注：Remotion 自带 ffmpeg 为精简构建，无 asplit，故逐段调用 atrim。
async function cutBySamples(
  masterPath: string,
  sampleBounds: number[],
  outFiles: string[],
  sampleRate: number,
  channels: number
): Promise<void> {
  const n = outFiles.length;
  for (let i = 0; i < n; i++) {
    await runText(FFMPEG, [
      "-v", "error", "-y", "-i", masterPath,
      "-af", `atrim=start_sample=${sampleBounds[i]}:end_sample=${sampleBounds[i + 1]},asetpts=PTS-STARTPTS`,
      "-c:a", "pcm_s16le", "-ar", String(sampleRate), "-ac", String(channels), outFiles[i],
    ], 32 * 1024 * 1024);
  }
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

// 参数解析（字符串/数字 -> 数字，并夹紧到合法范围）
function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

interface SplitSegment {
  index: number;
  filename: string;
  url: string;
  httpUrl: string;
  startInSeconds: number;
  endInSeconds: number;
  durationInSeconds: number;
  startSample: number;
  endSample: number;
  samples: number;
  size: number;
}

// 切分主流程
async function splitAudio(params: {
  sourcePath: string;
  sourceName: string;
  taskId: string;
  maxDuration: number;
  minDuration: number;
  tolerance: number;
  sensitivity: number;
  minSilence: number;
}) {
  const { sourcePath, sourceName, taskId, maxDuration, minDuration, sensitivity, minSilence, tolerance } = params;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-split-"));

  try {
    // 1) 读取源音频参数（采样率 / 声道）
    let sampleRate = 44100;
    let channels = 2;
    try {
      const probe = JSON.parse(
        await runText(FFPROBE, [
          "-v", "quiet", "-print_format", "json",
          "-show_streams", "-select_streams", "a:0", sourcePath,
        ])
      );
      const st = probe.streams?.[0];
      if (!st) throw new SplitError(400, "源文件不包含音频流");
      sampleRate = parseInt(st.sample_rate, 10) || 44100;
      channels = st.channels || 1;
    } catch (e) {
      if (e instanceof SplitError) throw e;
      throw new SplitError(400, "ffprobe 无法解析源音频信息，请确认文件是有效音频");
    }

    // 2) 分析流：单声道 / 22050Hz / WAV(pcm_s16le)（仅用于 DSP，不影响切割精度）
    //    注意：Remotion 自带 ffmpeg 为精简构建，不支持 f32le/裸流与 pcm_f32le，仅能用 wav+s16。
    const analysisPath = path.join(tmpDir, "analysis.wav");
    await runText(FFMPEG, [
      "-v", "error", "-y", "-i", sourcePath,
      "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", analysisPath,
    ], 32 * 1024 * 1024);

    // 3) 切割母版：保留源采样率/声道的 PCM WAV（样本级精确切割的基础）
    const masterPath = path.join(tmpDir, "master.wav");
    await runText(FFMPEG, [
      "-v", "error", "-y", "-i", sourcePath,
      "-vn", "-c:a", "pcm_s16le", "-ar", String(sampleRate), "-ac", String(channels), masterPath,
    ], 32 * 1024 * 1024);

    const totalSamples = wavDataSamples(masterPath, channels);
    if (totalSamples <= 0) throw new SplitError(400, "无法读取源音频样本数据");
    const totalDuration = totalSamples / sampleRate;

    // 4) DSP：特征提取 + 候选切点
    const mono = readMonoWavFloat(analysisPath);
    if (mono.length === 0) throw new SplitError(400, "无法读取分析音频样本");
    const feat = extractFeatures(mono, 22050);
    const candidates = pickCandidates(feat, sensitivity, minSilence);

    // 5) 规划边界（秒 -> 样本号）
    const boundaries = planBoundaries(candidates, totalDuration, maxDuration, minDuration, tolerance);
    const sampleBounds: number[] = [];
    for (const t of boundaries) {
      const s = Math.min(totalSamples, Math.max(0, Math.round(t * sampleRate)));
      if (sampleBounds.length === 0) {
        sampleBounds.push(0);
      } else if (s > sampleBounds[sampleBounds.length - 1]) {
        sampleBounds.push(s);
      }
    }
    if (sampleBounds[sampleBounds.length - 1] !== totalSamples) sampleBounds.push(totalSamples);
    if (sampleBounds.length < 2) throw new SplitError(400, "音频过短，无法切分");

    // 6) 输出到 public/audio/<taskId>/（复用现有 /audio 静态服务访问）
    const outDir = path.resolve(AUDIO_DIR, taskId);
    if (!outDir.startsWith(AUDIO_DIR + path.sep)) throw new SplitError(400, "非法的任务目录名");
    fs.mkdirSync(outDir, { recursive: true });

    const segCount = sampleBounds.length - 1;
    const digits = Math.max(3, String(segCount).length);
    const outFiles: string[] = [];
    for (let i = 0; i < segCount; i++) {
      outFiles.push(path.join(outDir, `${String(i + 1).padStart(digits, "0")}.wav`));
    }
    await cutBySamples(masterPath, sampleBounds, outFiles, sampleRate, channels);

    // 7) 校验：样本守恒 + 边界连续 + 每段不超上限
    const segments: SplitSegment[] = [];
    let sumSamples = 0;
    let maxSegDuration = 0;
    for (let i = 0; i < segCount; i++) {
      const fileName = path.basename(outFiles[i]);
      const samples = wavDataSamples(outFiles[i], channels);
      const segDuration = samples / sampleRate;
      sumSamples += samples;
      if (segDuration > maxSegDuration) maxSegDuration = segDuration;
      segments.push({
        index: i,
        filename: fileName,
        url: `/audio/${taskId}/${fileName}`,
        httpUrl: `${SERVER_URL}/audio/${taskId}/${fileName}`,
        startInSeconds: round2(sampleBounds[i] / sampleRate),
        endInSeconds: round2(sampleBounds[i + 1] / sampleRate),
        durationInSeconds: round2(segDuration),
        startSample: sampleBounds[i],
        endSample: sampleBounds[i + 1],
        samples,
        size: fs.statSync(outFiles[i]).size,
      });
    }

    const continuous = segments.every((s, i) => i === 0 || s.startSample === segments[i - 1].endSample);
    const verification = {
      sumOfSegmentDurations: round2(sumSamples / sampleRate),
      sourceDuration: round2(totalDuration),
      differenceInSeconds: round2(sumSamples / sampleRate - totalDuration),
      sumOfSamples: sumSamples,
      sourceSamples: totalSamples,
      boundariesContinuous: continuous,
      maxSegmentDuration: round2(maxSegDuration),
    };

    if (!continuous || sumSamples !== totalSamples || maxSegDuration > maxDuration + 1 / sampleRate) {
      throw new SplitError(500, `切分校验失败：${JSON.stringify(verification)}`);
    }

    const result = {
      success: true,
      taskId,
      dir: `audio/${taskId}`,
      source: {
        filename: sourceName,
        durationInSeconds: round2(totalDuration),
        sampleRate,
        channels,
        totalSamples,
      },
      outputFormat: "wav",
      segmentCount: segCount,
      segments,
      verification,
    };

    // 8) 写入 manifest.json 供下游（如 Remotion）读取
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(result, null, 2), "utf8");

    // 9) 同步到 bundle 目录（渲染时可直接引用）
    if (bundleLocation) {
      const bundleDir = path.resolve(bundleLocation, "public/audio", taskId);
      fs.mkdirSync(bundleDir, { recursive: true });
      for (const f of fs.readdirSync(outDir)) {
        fs.copyFileSync(path.join(outDir, f), path.join(bundleDir, f));
      }
    }

    console.log(`Audio split: ${sourceName} -> ${segCount} segments in audio/${taskId}`);
    return result;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

app.post("/api/audio/split", (req, res) => {
  (req as any)._uploadDir = "audio";
  fileUpload.single("file")(req, res, async (err) => {
    if (err) {
      if (err instanceof multer.MulterError) res.status(400).json({ error: `Upload error: ${err.message}` });
      else res.status(400).json({ error: err.message });
      return;
    }
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const pick = (key: string): unknown =>
        req.query?.[key] !== undefined ? req.query[key] : body[key];

      // 源文件：优先 multipart 上传的文件，其次 filename（public/audio 内已有文件）
      let sourcePath = "";
      let sourceName = "";
      if (req.file) {
        sourcePath = req.file.path;
        sourceName = req.file.filename;
      } else {
        const name = (pick("filename") as string) || "";
        if (!name) throw new SplitError(400, "缺少源音频：传 filename（public/audio 内文件）或 multipart 字段 file");
        const cleaned = path.basename(name.replace(/^audio\//, ""));
        const fp = path.resolve(AUDIO_DIR, cleaned);
        if (!fp.startsWith(AUDIO_DIR + path.sep) || !fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
          throw new SplitError(404, `源音频不存在：${name}`);
        }
        sourcePath = fp;
        sourceName = cleaned;
      }

      const maxDuration = clampNum(pick("maxDuration"), 15, 1, 600);
      const minDuration = clampNum(pick("minDuration"), 5, 0.1, maxDuration);
      const tolerance = clampNum(pick("tolerance"), 2, 0, maxDuration);
      const sensitivity = clampNum(pick("sensitivity"), 0.5, 0, 5);
      const minSilence = clampNum(pick("minSilence"), 0.3, 0.05, 10);
      if (minDuration >= maxDuration) throw new SplitError(400, "minDuration 必须小于 maxDuration");

      const rawTaskId = (pick("taskId") as string) || "";
      const prefix = (pick("prefix") as string) || "";
      const base = rawTaskId || `${prefix ? `${path.basename(prefix).replace(/\.[A-Za-z0-9]{1,10}$/, "")}_` : ""}${uuidv4().slice(0, 8)}`;
      const taskId = path.basename(base).replace(/[\\/:*?"<>|]/g, "_") || `split_${uuidv4().slice(0, 8)}`;

      const result = await splitAudio({
        sourcePath,
        sourceName,
        taskId,
        maxDuration,
        minDuration,
        tolerance,
        sensitivity,
        minSilence,
      });
      res.json(result);
    } catch (e) {
      if (e instanceof SplitError) {
        res.status(e.status).json({ error: e.message });
        return;
      }
      console.error("Audio split error:", e);
      res.status(500).json({
        error: "Failed to split audio",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
});

// ========== 视频拼接 ==========
/** 解析 ffprobe 的帧率字段（形如 "30000/1001"）为数值 */
function parseFrameRate(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const [num, den] = v.split("/").map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

async function getVideoInfo(filePath: string): Promise<{
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
  codec: string;
} | null> {
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        filePath,
      ],
      (err, stdout) => {
        if (err) { resolve(null); return; }
        try {
          const data = JSON.parse(stdout);
          const videoStream = data.streams?.find((s: Record<string, unknown>) => s.codec_type === "video");
          const audioStream = data.streams?.find((s: Record<string, unknown>) => s.codec_type === "audio");
          if (!videoStream) { resolve(null); return; }
          resolve({
            width: videoStream.width || 0,
            height: videoStream.height || 0,
            duration: parseFloat(data.format?.duration || "0"),
            fps:
              parseFrameRate(videoStream.avg_frame_rate) ||
              parseFrameRate(videoStream.r_frame_rate),
            hasAudio: !!audioStream,
            codec: videoStream.codec_name || "unknown",
          });
        } catch { resolve(null); }
      }
    );
  });
}

app.post("/api/video/concat", async (req, res) => {
  const { files: filesRaw, filename: filenameRaw, outputWidth, outputHeight, outputName } = req.body || {};

  // 兼容多种入参：files / filename，可为数组或单个字符串；按数组顺序合并
  const raw = filesRaw ?? filenameRaw;
  const files: any[] = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  if (files.length < 2) {
    res.status(400).json({ error: "files/filename must contain at least 2 entries" });
    return;
  }

  try {
    // 1. 解析所有输入文件路径和视频信息
    const inputs: string[] = [];
    const videoList: {
      index: number;
      path: string;
      info: NonNullable<Awaited<ReturnType<typeof getVideoInfo>>>;
      mute: boolean;
      audioTrack: string | undefined;
      audioTrackIdx: number; // -1 表示没有额外音轨
    }[] = [];

    let inputIdx = 0;
    for (const item of files) {
      const filename = (item.filename || item.src || item) as string;
      if (typeof filename !== "string" || filename.trim().length === 0) {
        res.status(400).json({ error: "Each file must have a filename/src" });
        return;
      }

      const videoPath = path.resolve(PUBLIC_DIR, filename.startsWith("public/") ? filename.slice(7) : filename);
      if (!videoPath.startsWith(PUBLIC_DIR) || !fs.existsSync(videoPath)) {
        res.status(400).json({ error: `File not found: ${filename}` });
        return;
      }

      const info = await getVideoInfo(videoPath);
      if (!info) {
        res.status(400).json({ error: `Cannot read video info: ${filename}` });
        return;
      }

      const mute = !!(item.mute);
      const audioTrack = typeof item.audioTrack === "string" ? item.audioTrack.trim() : undefined;
      let audioTrackIdx = -1;
      let audioTrackPath = "";

      if (audioTrack) {
        // 搜索音轨文件
        const candidates = [
          path.resolve(AUDIO_DIR, audioTrack),
          path.resolve(MUSIC_DIR, audioTrack),
          path.resolve(PUBLIC_DIR, audioTrack),
        ];
        audioTrackPath = candidates.find((p) => fs.existsSync(p)) || "";
        if (!audioTrackPath) {
          res.status(400).json({ error: `Audio track not found: ${audioTrack}` });
          return;
        }
        inputs.push(audioTrackPath);
        audioTrackIdx = inputIdx;
        inputIdx++;
      }

      inputs.push(videoPath);
      videoList.push({ index: inputIdx, path: videoPath, info, mute, audioTrack, audioTrackIdx });
      inputIdx++;
    }

    // 2. 目标分辨率
    const targetW = outputWidth || videoList[0].info.width;
    const targetH = outputHeight || videoList[0].info.height;

    // 3. 构建 filter_complex
    const filterParts: string[] = [];
    const vStreams: string[] = [];
    const aStreams: string[] = [];
    let hasAnyAudio = false;

    for (const v of videoList) {
      const vi = v.index;

      // Video: 统一到目标分辨率与像素格式（保证 concat 尺寸一致）
      // 注：Remotion 自带 ffmpeg 无 pad/setsar/fps 滤镜，故用 scale(cover)+crop 取代 scale(pad)
      filterParts.push(
        `[${vi}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH},format=yuv420p[v${vi}]`
      );
      vStreams.push(`[v${vi}]`);

      // Audio
      if (v.audioTrack && v.audioTrackIdx >= 0) {
        // 有新音轨
        const ati = v.audioTrackIdx;
        filterParts.push(`[${ati}:a]aformat=sample_rates=44100:channel_layouts=stereo[a_track${vi}]`);
        if (!v.mute && v.info.hasAudio) {
          filterParts.push(`[${vi}:a]aformat=sample_rates=44100:channel_layouts=stereo[a_orig${vi}];[a_orig${vi}][a_track${vi}]amix=inputs=2:duration=first[a${vi}]`);
        } else {
          filterParts.push(`[a_track${vi}]anull[a${vi}]`);
        }
        aStreams.push(`[a${vi}]`);
        hasAnyAudio = true;
      } else if (!v.mute && v.info.hasAudio) {
        filterParts.push(`[${vi}:a]aformat=sample_rates=44100:channel_layouts=stereo[a${vi}]`);
        aStreams.push(`[a${vi}]`);
        hasAnyAudio = true;
      }
      // else: muted and no replacement → no audio stream for this video
    }

    // 如果部分有音频、部分没有，给没音频的补静音（concat 要求流数量一致）
    if (hasAnyAudio && aStreams.length < videoList.length) {
      for (const v of videoList) {
        const vi = v.index;
        const dur = v.info.duration || 10;
        if (!aStreams.includes(`[a${vi}]`)) {
          filterParts.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${dur}[a${vi}]`);
        }
      }
      // Rebuild aStreams in correct order
      aStreams.length = 0;
      for (const v of videoList) {
        aStreams.push(`[a${v.index}]`);
      }
    }

    // Concat: 必须按 [v0][a0][v1][a1]... 顺序混合
    const n = videoList.length;
    const concatInputs: string[] = [];
    for (let i = 0; i < n; i++) {
      const vi = videoList[i].index;
      concatInputs.push(`[v${vi}]`);
      if (hasAnyAudio || aStreams.length === n) {
        concatInputs.push(`[a${vi}]`);
      }
    }
    if (hasAnyAudio || aStreams.length === n) {
      filterParts.push(`${concatInputs.join("")}concat=n=${n}:v=1:a=1[outv][outa]`);
    } else {
      filterParts.push(`${concatInputs.join("")}concat=n=${n}:v=1:a=0[outv]`);
    }

    const filterComplex = filterParts.join(";");

    // 4. 构建 ffmpeg 参数
    const outName = outputName && typeof outputName === "string"
      ? `${uuidv4()}_${path.basename(outputName)}`
      : `${uuidv4()}_concat.mp4`;

    const outDir = path.resolve(PUBLIC_DIR, "video");
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.resolve(outDir, outName);

    const ffmpegArgs: string[] = [];
    for (const inp of inputs) {
      ffmpegArgs.push("-i", inp);
    }
    ffmpegArgs.push("-filter_complex", filterComplex);
    if (hasAnyAudio || aStreams.length === n) {
      ffmpegArgs.push("-map", "[outv]", "-map", "[outa]");
    } else {
      ffmpegArgs.push("-map", "[outv]");
    }
    ffmpegArgs.push("-c:v", "libx264", "-crf", "23", "-preset", "medium");
    ffmpegArgs.push("-c:a", "aac", "-b:a", "128k");
    ffmpegArgs.push("-y", outputPath);

    console.log(`Concatenating ${n} videos -> ${outName}`);
    console.log(`Filter: ${filterComplex.substring(0, 200)}...`);

    execFile(FFMPEG, ffmpegArgs, { maxBuffer: 1024 * 1024 * 10 }, (err) => {
      if (err) {
        console.error("ffmpeg concat error:", err);
        res.status(500).json({ error: "Failed to concatenate videos", message: err.message });
        return;
      }

      // 复制到 bundle
      if (bundleLocation) {
        const bundleOut = path.resolve(bundleLocation, "public/video");
        fs.mkdirSync(bundleOut, { recursive: true });
        fs.copyFileSync(outputPath, path.resolve(bundleOut, outName));
      }

      const stats = fs.statSync(outputPath);
      const totalDuration = videoList.reduce((sum, v) => sum + v.info.duration, 0);

      res.json({
        success: true,
        output: {
          filename: `video/${outName}`,
          url: `/static/video/${outName}`,
          sizeBytes: stats.size,
          width: targetW,
          height: targetH,
          totalDurationSeconds: Math.round(totalDuration * 10) / 10,
          videoCount: n,
        },
      });
    });
  } catch (e) {
    console.error("Video concat error:", e);
    res.status(500).json({
      error: "Video concat failed",
      message: e instanceof Error ? e.message : String(e),
    });
  }
});

// ========== 视频按时间轴切割 ==========
/** 顺序执行 ffmpeg，失败时 reject（截取 stderr 末尾几行作为错误信息） */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = String(stderr || err.message).trim().split("\n").slice(-3).join(" | ");
        reject(new Error(tail || err.message));
        return;
      }
      resolve();
    });
  });
}

app.post("/api/video/cut", (req, res) => {
  // 源视频与参数就绪后执行切割；segments 只取 start/end，其余字段原样回传
  const handle = async (videoPath: string, sourceInfo: Record<string, unknown>) => {
    try {
      const raw = (req.body || {}).segments;
      let segmentsRaw: unknown = raw;
      if (typeof raw === "string") {
        try {
          segmentsRaw = JSON.parse(raw);
        } catch {
          segmentsRaw = null;
        }
      }
      if (!Array.isArray(segmentsRaw) || segmentsRaw.length === 0) {
        res.status(400).json({ success: false, error: "segments must be a non-empty array" });
        return;
      }

      const info = await getVideoInfo(videoPath);
      const duration = info?.duration || 0;

      // 校验并归一化每个时间段；end 超出视频时长时收敛到视频结尾
      const segs: { start: number; end: number; extra: Record<string, unknown> }[] = [];
      for (let i = 0; i < segmentsRaw.length; i++) {
        const s = (segmentsRaw[i] || {}) as Record<string, unknown>;
        const start = numOpt(s.start, NaN);
        const end = numOpt(s.end, NaN);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          res.status(400).json({ success: false, error: `Invalid segment at index ${i}: start and end are required (end > start)` });
          return;
        }
        const cs = Math.max(0, start);
        const ce = duration > 0 ? Math.min(end, duration) : end;
        if (ce <= cs) {
          res.status(400).json({ success: false, error: `Segment ${i} is empty after clamping to video duration (${duration}s)` });
          return;
        }
        const extra: Record<string, unknown> = {};
        for (const k of Object.keys(s)) {
          if (k !== "start" && k !== "end") extra[k] = s[k];
        }
        segs.push({ start: cs, end: ce, extra });
      }

      const jobId = uuidv4();
      const relDir = path.posix.join("video", "cuts", jobId);
      const outDir = path.resolve(PUBLIC_DIR, relDir);
      fs.mkdirSync(outDir, { recursive: true });

      const results: Record<string, unknown>[] = [];
      let totalBytes = 0;
      for (let i = 0; i < segs.length; i++) {
        const { start, end, extra } = segs[i];
        const segDur = Math.round((end - start) * 1000) / 1000;
        const name = `seg_${String(i).padStart(3, "0")}.mp4`;
        const outPath = path.resolve(outDir, name);

        // 重编码切割，切点精确到帧（源视频无音轨时 -c:a 会被忽略，不影响）
        await runFfmpeg([
          "-ss", String(start),
          "-i", videoPath,
          "-t", String(segDur),
          "-c:v", "libx264", "-crf", "23", "-preset", "medium",
          "-c:a", "aac", "-b:a", "128k",
          "-y", outPath,
        ]);

        const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
        totalBytes += size;
        results.push({
          index: i,
          start,
          end,
          durationSeconds: segDur,
          ...extra,
          filename: `${relDir}/${name}`,
          url: `/static/${relDir}/${name}`,
          sizeBytes: size,
        });
      }

      // 同步到 bundle，便于后续直接用于渲染
      if (bundleLocation) {
        const bundleOut = path.resolve(bundleLocation, "public", relDir);
        fs.mkdirSync(bundleOut, { recursive: true });
        for (const r of results) {
          fs.copyFileSync(path.resolve(PUBLIC_DIR, r.filename as string), path.resolve(bundleOut, path.basename(r.filename as string)));
        }
      }

      res.json({
        success: true,
        source: sourceInfo,
        count: results.length,
        dir: relDir,
        totalBytes,
        segments: results,
      });
    } catch (e) {
      console.error("Video cut error:", e);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      handle(req.file.path, { filename: relPath, originalName: req.file.originalname, size: req.file.size, url: `/static/${relPath}` });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  handle(localPath, { filename });
});

// ========== 视频画面裁剪（去边框） ==========
app.post("/api/video/crop", (req, res) => {
  // 从四周裁掉边框：top/left/right/bottom 单位为像素，输出尺寸 = 源尺寸减去四边裁剪量
  const handle = async (videoPath: string, sourceInfo: Record<string, unknown>) => {
    try {
      const body = (req.body || {}) as Record<string, unknown>;
      const pick = (k: string) => body[k] ?? req.query?.[k];

      const info = await getVideoInfo(videoPath);
      if (!info || !info.width || !info.height) {
        res.status(400).json({ success: false, error: "Cannot read video dimensions" });
        return;
      }

      const top = Math.round(numOpt(pick("top"), 0));
      const left = Math.round(numOpt(pick("left"), 0));
      const right = Math.round(numOpt(pick("right"), 0));
      const bottom = Math.round(numOpt(pick("bottom"), 0));
      if ([top, left, right, bottom].some((v) => v < 0)) {
        res.status(400).json({ success: false, error: "top/left/right/bottom must be >= 0" });
        return;
      }

      let outW = info.width - left - right;
      let outH = info.height - top - bottom;
      if (outW <= 0 || outH <= 0) {
        res.status(400).json({
          success: false,
          error: `Crop is empty: source is ${info.width}x${info.height}, but left+right=${left + right} and top+bottom=${top + bottom}`,
        });
        return;
      }

      // H.264 (yuv420p) 要求宽高为偶数，向下取整为偶数（同时保证裁剪区域不越界）
      const evenDown = (n: number) => (n % 2 === 0 ? n : n - 1);
      outW = evenDown(outW);
      outH = evenDown(outH);

      const jobId = uuidv4();
      const relDir = path.posix.join("video", "crops", jobId);
      const outDir = path.resolve(PUBLIC_DIR, relDir);
      fs.mkdirSync(outDir, { recursive: true });

      const name = "cropped.mp4";
      const outPath = path.resolve(outDir, name);
      await runFfmpeg([
        "-i", videoPath,
        "-vf", `crop=${outW}:${outH}:${left}:${top}`,
        "-c:v", "libx264", "-crf", "23", "-preset", "medium",
        "-c:a", "aac", "-b:a", "128k",
        "-y", outPath,
      ]);

      const size = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
      const relFile = `${relDir}/${name}`;

      // 同步到 bundle，便于后续直接用于渲染
      if (bundleLocation) {
        const bundleOut = path.resolve(bundleLocation, "public", relDir);
        fs.mkdirSync(bundleOut, { recursive: true });
        fs.copyFileSync(outPath, path.resolve(bundleOut, name));
      }

      res.json({
        success: true,
        source: sourceInfo,
        original: { width: info.width, height: info.height },
        crop: { top, left, right, bottom },
        output: { width: outW, height: outH },
        duration: Math.round(info.duration * 1000) / 1000,
        hasAudio: info.hasAudio,
        video: { filename: relFile, url: `/static/${relFile}`, sizeBytes: size },
      });
    } catch (e) {
      console.error("Video crop error:", e);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      handle(req.file.path, { filename: relPath, originalName: req.file.originalname, size: req.file.size, url: `/static/${relPath}` });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  handle(localPath, { filename });
});

// ========== 视频 / 音轨分离 ==========
app.post("/api/video/split-av", (req, res) => {
  // 将视频的画面与音轨分离：输出无音轨视频 + 音频 WAV，存入本地并返回访问地址
  const handle = async (videoPath: string, sourceInfo: Record<string, unknown>) => {
    try {
      const info = await getVideoInfo(videoPath);
      const hasAudio = !!info?.hasAudio;

      const jobId = uuidv4();
      const relDir = path.posix.join("video", "av", jobId);
      const outDir = path.resolve(PUBLIC_DIR, relDir);
      fs.mkdirSync(outDir, { recursive: true });

      // 1) 无音轨视频：直接复制视频流并剥离音频（无损、快速）
      const videoRel = `${relDir}/video.mp4`;
      const videoOut = path.resolve(outDir, "video.mp4");
      await runFfmpeg(["-i", videoPath, "-map", "0:v:0", "-c:v", "copy", "-an", "-y", videoOut]);

      // 2) 音频 WAV：16bit PCM，保留原始采样率与声道
      let audioRel: string | null = null;
      let audioSize = 0;
      if (hasAudio) {
        audioRel = `${relDir}/audio.wav`;
        const audioOut = path.resolve(outDir, "audio.wav");
        await runFfmpeg(["-i", videoPath, "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", "-y", audioOut]);
        audioSize = fs.existsSync(audioOut) ? fs.statSync(audioOut).size : 0;
      }

      const videoSize = fs.existsSync(videoOut) ? fs.statSync(videoOut).size : 0;

      // 同步到 bundle，便于后续直接用于渲染
      if (bundleLocation) {
        const bundleOut = path.resolve(bundleLocation, "public", relDir);
        fs.mkdirSync(bundleOut, { recursive: true });
        fs.copyFileSync(videoOut, path.resolve(bundleOut, "video.mp4"));
        if (audioRel) {
          fs.copyFileSync(path.resolve(outDir, "audio.wav"), path.resolve(bundleOut, "audio.wav"));
        }
      }

      res.json({
        success: true,
        source: sourceInfo,
        duration: info ? Math.round(info.duration * 1000) / 1000 : undefined,
        hasAudio,
        video: {
          filename: videoRel,
          url: `/static/${videoRel}`,
          sizeBytes: videoSize,
        },
        audio: audioRel
          ? { filename: audioRel, url: `/static/${audioRel}`, sizeBytes: audioSize }
          : null,
        ...(hasAudio ? {} : { warning: "Source video has no audio track; only a silent video was produced." }),
      });
    } catch (e) {
      console.error("Video split-av error:", e);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      handle(req.file.path, { filename: relPath, originalName: req.file.originalname, size: req.file.size, url: `/static/${relPath}` });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  handle(localPath, { filename });
});

// ========== 清理 ==========
// audio 下需保留的子目录（其余连同内容一并清除）
const AUDIO_KEEP = new Set(["music", "ref"]);

interface CleanStat {
  files: number;
  dirs: number;
  bytes: number;
}

// 判断 target 是否严格位于 base 内（含 base 自身）
function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// 递归删除文件/目录（符号链接按文件处理，不会跟随逃逸），并累计统计
function removePath(p: string, stat: CleanStat): void {
  const lst = fs.lstatSync(p);
  if (lst.isDirectory()) {
    for (const name of fs.readdirSync(p)) removePath(path.join(p, name), stat);
    fs.rmdirSync(p);
    stat.dirs++;
  } else {
    stat.bytes += lst.size;
    fs.unlinkSync(p);
    stat.files++;
  }
}

// 清空目录内容：删除其中所有文件与子目录（keep 中的子目录保留，不递归）
function cleanDirContents(
  dir: string,
  keep: Set<string>
): { stat: CleanStat; kept: string[] } {
  const stat: CleanStat = { files: 0, dirs: 0, bytes: 0 };
  const kept: string[] = [];
  if (!fs.existsSync(dir)) return { stat, kept };

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (keep.has(entry.name)) {
        kept.push(entry.name);
        continue;
      }
      removePath(fp, stat);
    } else {
      stat.bytes += lstatSize(fp);
      fs.unlinkSync(fp);
      stat.files++;
    }
  }
  return { stat, kept };
}

function lstatSize(p: string): number {
  try {
    return fs.lstatSync(p).size;
  } catch {
    return 0;
  }
}

app.post("/api/cleanup", (req, res) => {
  const requested: string[] =
    Array.isArray(req.body?.targets) && req.body.targets.length
      ? req.body.targets
      : ["publicRoot", "uploads", "video", "audio"];

  const PUBLIC_REAL = fs.existsSync(PUBLIC_DIR) ? fs.realpathSync(PUBLIC_DIR) : PUBLIC_DIR;
  const errors: { target: string; message: string }[] = [];
  const detail: Record<string, { files: number; dirs: number; kept?: string[] }> = {};
  const summary: CleanStat = { files: 0, dirs: 0, bytes: 0 };

  for (const target of requested) {
    try {
      if (target === "publicRoot") {
        // 仅删除 public 根目录下的文件，保留所有子目录（不递归）
        const stat: CleanStat = { files: 0, dirs: 0, bytes: 0 };
        const kept: string[] = [];
        if (fs.existsSync(PUBLIC_REAL)) {
          for (const entry of fs.readdirSync(PUBLIC_REAL, { withFileTypes: true })) {
            const fp = path.join(PUBLIC_REAL, entry.name);
            if (entry.isDirectory()) {
              kept.push(entry.name);
              continue;
            }
            if (!isInside(PUBLIC_REAL, fp)) {
              errors.push({ target, message: `Skip (outside public): ${entry.name}` });
              continue;
            }
            stat.bytes += lstatSize(fp);
            fs.unlinkSync(fp);
            stat.files++;
          }
        }
        summary.files += stat.files;
        summary.dirs += stat.dirs;
        summary.bytes += stat.bytes;
        detail.publicRoot = { files: stat.files, dirs: 0, kept };
      } else if (target === "uploads" || target === "video" || target === "audio") {
        const dir = path.resolve(PUBLIC_REAL, target);
        if (!isInside(PUBLIC_REAL, dir) || !fs.existsSync(dir)) {
          errors.push({ target, message: `Directory not found: ${target}` });
          continue;
        }
        const keep = target === "audio" ? AUDIO_KEEP : new Set<string>();
        const { stat, kept } = cleanDirContents(dir, keep);
        // 目录本身保留；若被删除则重建，避免后续上传/合并因缺目录报错
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        summary.files += stat.files;
        summary.dirs += stat.dirs;
        summary.bytes += stat.bytes;
        detail[target] = { files: stat.files, dirs: stat.dirs, ...(target === "audio" ? { kept } : {}) };
      } else {
        errors.push({ target, message: `Unknown target: ${target}` });
      }
    } catch (e) {
      errors.push({ target, message: e instanceof Error ? e.message : String(e) });
    }
  }

  res.json({
    success: errors.length === 0,
    summary: { filesDeleted: summary.files, dirsDeleted: summary.dirs, bytesFreed: summary.bytes },
    detail,
    errors,
  });
});

// ========== 人脸时间段检测（InsightFace） ==========
// 使用项目内隔离环境 .faceenv（不污染系统）；脚本与模型均在 python/ 下
const FACE_PYTHON = process.env.FACE_PYTHON || path.resolve(".faceenv/bin/python");
const FACE_SCRIPT = process.env.FACE_SCRIPT || path.resolve("python/face_detect.py");

function numOpt(v: unknown, def: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : def;
}

app.post("/api/face/detect", (req, res) => {
  // 两种入参：multipart 上传视频（字段 file），或 filename 指向 public/ 下已有视频
  const runDetect = (videoPath: string, fileInfo: Record<string, unknown>) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const pick = (k: string) => body[k] ?? req.query?.[k];

    const args = [
      FACE_SCRIPT,
      videoPath,
      "--sample-fps", String(numOpt(pick("sampleFps"), 2)),
      "--det-thresh", String(numOpt(pick("detThresh"), 0.5)),
      "--det-size", String(numOpt(pick("detSize"), 640)),
      "--max-samples", String(numOpt(pick("maxSamples"), 1200)),
      "--ctx-id", String(numOpt(pick("ctxId"), -1)),
      "--upscale", String(numOpt(pick("upscale"), 0)),
    ];
    const name = pick("name");
    if (typeof name === "string" && name) args.push("--name", name);

    execFile(
      FACE_PYTHON,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        // 脚本始终向 stdout 打印单个 JSON 对象
        let parsed: any = null;
        try {
          parsed = JSON.parse(String(stdout).trim());
        } catch {
          /* ignore */
        }
        if (parsed && parsed.success) {
          res.json({ ...parsed, file: fileInfo });
          return;
        }
        const message =
          (parsed && parsed.error) ||
          (stderr && String(stderr).trim().split("\n").slice(-3).join(" | ")) ||
          (err ? err.message : "Face detection failed");
        const bad = typeof message === "string" && /cannot open|not found/i.test(message);
        res.status(bad ? 400 : 500).json({ success: false, error: message, file: fileInfo });
      }
    );
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      runDetect(req.file.path, {
        filename: relPath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relPath}`,
      });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  runDetect(localPath, { filename, size: fs.statSync(localPath).size });
});

// ========== 语音转字幕（faster-whisper） ==========
// 复用与人脸检测相同的项目内隔离环境 .faceenv（不污染系统）；脚本与模型均在 python/ 下
const WHISPER_PYTHON = process.env.WHISPER_PYTHON || FACE_PYTHON;
const WHISPER_SCRIPT = process.env.WHISPER_SCRIPT || path.resolve("python/transcribe.py");

app.post("/api/transcribe", (req, res) => {
  // 两种入参：multipart 上传音/视频（字段 file），或 filename 指向 public/ 下已有文件
  const runTranscribe = (mediaPath: string, fileInfo: Record<string, unknown>) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const pick = (k: string) => body[k] ?? req.query?.[k];

    // 输出目录：public/subtitles/<jobId>/subtitle.srt（并同步到 bundle）
    const jobId = uuidv4();
    const relDir = path.posix.join("subtitles", jobId);
    const outDir = path.resolve(PUBLIC_DIR, relDir);
    fs.mkdirSync(outDir, { recursive: true });
    const srtName = "subtitle.srt";
    const srtOut = path.resolve(outDir, srtName);

    const args = [
      WHISPER_SCRIPT,
      mediaPath,
      "--srt-out", srtOut,
      "--model", String(pick("model") || "small"),
      "--language", String(pick("language") || "zh"),
      "--device", String(pick("device") || "cpu"),
      "--compute-type", String(pick("computeType") || "int8"),
      "--beam-size", String(numOpt(pick("beamSize"), 5)),
    ];
    if (pick("noVad") === true || pick("noVad") === "true") args.push("--no-vad");
    const prompt = pick("initialPrompt");
    if (typeof prompt === "string" && prompt) args.push("--initial-prompt", prompt);
    const modelRoot = pick("modelRoot");
    if (typeof modelRoot === "string" && modelRoot) args.push("--model-root", modelRoot);

    execFile(
      WHISPER_PYTHON,
      args,
      {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
        // 首次运行需下载模型：默认走 hf-mirror 并禁用 xet，可用环境变量覆盖
        env: {
          ...process.env,
          HF_ENDPOINT: process.env.HF_ENDPOINT || "https://hf-mirror.com",
          HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || "1",
        },
      },
      (err, stdout, stderr) => {
        // 脚本始终向 stdout 打印单个 JSON 对象
        let parsed: any = null;
        try {
          parsed = JSON.parse(String(stdout).trim());
        } catch {
          /* ignore */
        }
        if (parsed && parsed.success) {
          let srtFile: { filename: string; url: string; sizeBytes: number } | null = null;
          const relSrt = `${relDir}/${srtName}`;
          if (fs.existsSync(srtOut)) {
            if (bundleLocation) {
              const bundleOut = path.resolve(bundleLocation, "public", relDir);
              fs.mkdirSync(bundleOut, { recursive: true });
              fs.copyFileSync(srtOut, path.resolve(bundleOut, srtName));
            }
            srtFile = { filename: relSrt, url: `/static/${relSrt}`, sizeBytes: fs.statSync(srtOut).size };
          }
          res.json({
            success: true,
            source: fileInfo,
            language: parsed.language,
            languageProbability: parsed.languageProbability,
            duration: parsed.duration,
            model: parsed.model,
            segmentCount: parsed.segmentCount,
            srt: parsed.srt,
            srtFile,
            segments: parsed.segments,
          });
          return;
        }
        const message =
          (parsed && parsed.error) ||
          (stderr && String(stderr).trim().split("\n").slice(-3).join(" | ")) ||
          (err ? err.message : "Transcription failed");
        const bad = typeof message === "string" && /cannot open|not found|no such file|no audio/i.test(message);
        res.status(bad ? 400 : 500).json({ success: false, error: message, file: fileInfo });
      }
    );
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      runTranscribe(req.file.path, {
        filename: relPath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relPath}`,
      });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide an audio/video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Media not found: ${filename}` });
    return;
  }
  runTranscribe(localPath, { filename, size: fs.statSync(localPath).size });
});

// ========== 去人声（Demucs） ==========
// 复用与人脸检测相同的项目内隔离环境 .faceenv（不污染系统）；
// 使用 Demucs htdemucs 分离音轨，去除人物讲话（vocals），保留背景音（no_vocals）
const DEMUCS_PYTHON = process.env.DEMUCS_PYTHON || FACE_PYTHON;
const DEMUCS_SCRIPT = process.env.DEMUCS_SCRIPT || path.resolve("python/remove_vocals.py");
const DEMUCS_REPO = process.env.DEMUCS_REPO || path.resolve("python/.demucs-models");

app.post("/api/remove-vocals", (req, res) => {
  // 两种入参：multipart 上传音/视频（字段 file），或 filename 指向 public/ 下已有文件
  const runRemove = async (mediaPath: string, fileInfo: Record<string, unknown>) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const pick = (k: string) => body[k] ?? req.query?.[k];
    try {
      const jobId = uuidv4();
      const relDir = path.posix.join("audio", "no-vocals", jobId);
      const outDir = path.resolve(PUBLIC_DIR, relDir);
      fs.mkdirSync(outDir, { recursive: true });

      // 统一先抽取为标准 WAV（44.1k 立体声 16bit），使后续 Demucs 无需依赖 ffmpeg；
      // 源文件无音轨时 ffmpeg 会失败 -> 返回 400
      const wavIn = path.resolve(outDir, "source.wav");
      try {
        await runFfmpeg([
          "-i", mediaPath,
          "-map", "0:a:0", "-vn",
          "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le",
          "-y", wavIn,
        ]);
      } catch (e) {
        res.status(400).json({
          success: false,
          error: `No usable audio track found: ${e instanceof Error ? e.message : String(e)}`,
          source: fileInfo,
        });
        return;
      }

      const useMp3 = pick("format") === "mp3" || pick("mp3") === true || pick("mp3") === "true";
      const outName = useMp3 ? "no_vocals.mp3" : "no_vocals.wav";
      const outPath = path.resolve(outDir, outName);

      const args = [
        DEMUCS_SCRIPT,
        wavIn,
        "--out", outPath,
        "--model", String(pick("model") || "htdemucs"),
        "--repo", String(pick("repo") || DEMUCS_REPO),
        "--device", String(pick("device") || "cpu"),
        "--shifts", String(numOpt(pick("shifts"), 1)),
        "--overlap", String(numOpt(pick("overlap"), 0.25)),
        "--jobs", String(numOpt(pick("jobs"), 0)),
      ];
      const segment = pick("segment");
      if (segment !== undefined && segment !== null && segment !== "") {
        args.push("--segment", String(numOpt(segment, 0)));
      }
      if (useMp3) {
        args.push("--mp3", "--mp3-bitrate", String(numOpt(pick("mp3Bitrate"), 320)));
      }
      if (pick("int24") === true || pick("int24") === "true") args.push("--int24");
      if (pick("float32") === true || pick("float32") === "true") args.push("--float32");

      const keepStems = pick("keepStems") === true || pick("keepStems") === "true";
      const stemsDir = path.resolve(outDir, "stems");
      if (keepStems) args.push("--stems-out-dir", stemsDir);

      execFile(
        DEMUCS_PYTHON,
        args,
        { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 },
        (err, stdout, stderr) => {
          // 脚本始终向 stdout 打印单个 JSON 对象
          let parsed: any = null;
          try {
            parsed = JSON.parse(String(stdout).trim());
          } catch {
            /* ignore */
          }
          if (parsed && parsed.success) {
            const outExists = fs.existsSync(outPath);
            const result: Record<string, unknown> = {
              success: true,
              source: fileInfo,
              model: parsed.model,
              device: parsed.device,
              samplerate: parsed.samplerate,
              channels: parsed.channels,
              durationSeconds: parsed.durationSeconds,
              stems: parsed.stems,
              removed: parsed.removed,
              audio: outExists
                ? { filename: `${relDir}/${outName}`, url: `/static/${relDir}/${outName}`, sizeBytes: fs.statSync(outPath).size }
                : null,
            };
            if (keepStems && parsed.stemFiles) {
              const files: Record<string, unknown> = {};
              for (const [name, info] of Object.entries(parsed.stemFiles as Record<string, { path: string }>)) {
                const rel = `${relDir}/stems/${path.basename(info.path)}`;
                if (fs.existsSync(info.path)) {
                  files[name] = { filename: rel, url: `/static/${rel}`, sizeBytes: fs.statSync(info.path).size };
                }
              }
              result.stemFiles = files;
            }
            // 同步到 bundle，便于后续直接用于渲染
            if (bundleLocation && outExists) {
              const bundleOut = path.resolve(bundleLocation, "public", relDir);
              fs.mkdirSync(bundleOut, { recursive: true });
              fs.copyFileSync(outPath, path.resolve(bundleOut, outName));
              if (keepStems && fs.existsSync(stemsDir)) {
                const bStems = path.resolve(bundleOut, "stems");
                fs.mkdirSync(bStems, { recursive: true });
                for (const f of fs.readdirSync(stemsDir)) {
                  fs.copyFileSync(path.resolve(stemsDir, f), path.resolve(bStems, f));
                }
              }
            }
            // 清理临时 WAV，节省空间
            try {
              fs.rmSync(wavIn, { force: true });
            } catch {
              /* ignore */
            }
            res.json(result);
            return;
          }
          const message =
            (parsed && parsed.error) ||
            (stderr && String(stderr).trim().split("\n").slice(-3).join(" | ")) ||
            (err ? err.message : "Vocal removal failed");
          res.status(500).json({ success: false, error: message, source: fileInfo });
        }
      );
    } catch (e) {
      console.error("Remove vocals error:", e);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      runRemove(req.file.path, {
        filename: relPath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relPath}`,
      });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide an audio/video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Media not found: ${filename}` });
    return;
  }
  runRemove(localPath, { filename, size: fs.statSync(localPath).size });
});

// ========== 字幕上沿检测（OpenCV） ==========
// 复用与人脸检测相同的项目内隔离环境 .faceenv（不污染系统）；脚本在 python/ 下
const SUBTITLE_PYTHON = process.env.SUBTITLE_PYTHON || FACE_PYTHON;
const SUBTITLE_SCRIPT = process.env.SUBTITLE_SCRIPT || path.resolve("python/detect_subtitles.py");
// 学习型引擎（PP-OCR DBNet ONNX）：engine=ml 时改用该脚本
const SUBTITLE_ML_SCRIPT = process.env.SUBTITLE_ML_SCRIPT || path.resolve("python/text_detect.py");

app.post("/api/video/detect-subtitles", (req, res) => {
  // 跨帧采样检测整段视频中出现文字的位置（字幕 / 水印不作区分），响应 regions 为扁平数组
  // （regions[0]、regions[1]…，按请求顺序列出全部区域，每项带 detected，检出时为
  // {detected,left,top,right,bottom,width,height,confidence}）；顶层 segments 为全片出现文字的时间段
  const runDetect = (videoPath: string, fileInfo: Record<string, unknown>) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const pick = (k: string) => body[k] ?? req.query?.[k];

    const engine = String(pick("engine") || "ml").toLowerCase() === "heuristic" ? "heuristic" : "ml";
    const script = engine === "ml" ? SUBTITLE_ML_SCRIPT : SUBTITLE_SCRIPT;

    const args = [
      script,
      videoPath,
      "--sample-fps", String(numOpt(pick("sampleFps"), 1)),
      "--max-samples", String(numOpt(pick("maxSamples"), 600)),
      "--region-ratio", String(numOpt(pick("regionRatio"), 0.35)),
      "--gap-bridge", String(numOpt(pick("gapBridge"), engine === "ml" ? 1 : 8)),
      "--upscale", String(numOpt(pick("upscale"), 0)),
    ];

    if (engine === "ml") {
      // 学习型（PP-OCR DBNet ONNX）检测：更适合低对比 / 竖排 / 半透明 / 彩色文字
      args.push(
        "--det-thresh", String(numOpt(pick("detThresh"), 0.3)),
        "--min-text-ratio", String(numOpt(pick("minTextRatio"), 0.002)),
        "--min-box-area", String(numOpt(pick("minBoxArea"), 20)),
        "--det-limit", String(numOpt(pick("detLimit"), 960)),
        "--min-det-size", String(numOpt(pick("minDetSize"), 320)),
        "--provider", String(pick("provider") || "auto"),
      );
      if (pick("deviceId") !== undefined && pick("deviceId") !== null) {
        args.push("--device-id", String(numOpt(pick("deviceId"), 0)));
      }
      const model = pick("model");
      if (model) args.push("--model", String(model));
    } else {
      args.push(
        "--bright-thresh", String(numOpt(pick("brightThresh"), 200)),
        "--dark-thresh", String(numOpt(pick("darkThresh"), 100)),
        "--min-row-ratio", String(numOpt(pick("minRowRatio"), 0.05)),
        "--max-row-ratio", String(numOpt(pick("maxRowRatio"), 0.7)),
        "--freq-threshold", String(numOpt(pick("freqThreshold"), 0.05)),
        "--min-confidence", String(numOpt(pick("minConfidence"), 0.04)),
        "--min-band-height-ratio", String(numOpt(pick("minBandHeightRatio"), 0.015)),
        "--padding", String(numOpt(pick("padding"), 0)),
      );
      if (pick("edges") === true || pick("edges") === "true") args.push("--edges");
    }

    // 多区域扫描：regions 可为数组或 JSON 字符串；响应 regions[] 为扁平数组，
    // 按请求顺序列出全部区域（每项带 detected，未检出时坐标为 null）
    const regions = pick("regions");
    if (regions !== undefined && regions !== null) {
      const regionStr = typeof regions === "string" ? regions : JSON.stringify(regions);
      if (regionStr && regionStr !== "null") args.push("--regions", regionStr);
    }
    // ml 且未指定 regions 时走全画面自动检测，这两个参数控制其灵敏度
    if (engine === "ml" && (regions === undefined || regions === null)) {
      args.push(
        "--auto-freq-threshold", String(numOpt(pick("autoFreqThreshold"), 0.02)),
        "--auto-min-area-ratio", String(numOpt(pick("autoMinAreaRatio"), 0.0004)),
      );
    }

    execFile(
      SUBTITLE_PYTHON,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60 * 1000 },
      (err, stdout, stderr) => {
        // 脚本始终向 stdout 打印单个 JSON 对象
        let parsed: any = null;
        try {
          parsed = JSON.parse(String(stdout).trim());
        } catch {
          /* ignore */
        }
        if (parsed && parsed.success) {
          res.json({ ...parsed, file: fileInfo });
          return;
        }
        const message =
          (parsed && parsed.error) ||
          (stderr && String(stderr).trim().split("\n").slice(-3).join(" | ")) ||
          (err ? err.message : "Subtitle detection failed");
        const bad = typeof message === "string" && /cannot open|not found|no readable|no frames/i.test(message);
        res.status(bad ? 400 : 500).json({ success: false, error: message, file: fileInfo });
      }
    );
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      runDetect(req.file.path, {
        filename: relPath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relPath}`,
      });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  runDetect(localPath, { filename, size: fs.statSync(localPath).size });
});

// ========== 去水印 / 去字幕（VSR sttn-auto，支持遮罩） ==========
// 仅对传入的 regions（来自 detect-subtitles 的遮罩框）做修复，其余画面原样保留。
// 使用独立隔离环境 .vsrenv（Python 3.12 + torch cu126，支持 Pascal GPU），不污染系统与 .faceenv
const WM_PYTHON = process.env.WM_PYTHON || path.resolve(".vsrenv/bin/python");
const WM_SCRIPT = process.env.WM_SCRIPT || path.resolve("python/remove_watermark.py");

app.post("/api/video/remove-watermark", (req, res) => {
  // 入参：multipart 上传视频（字段 file）或 filename 指向 public/ 下已有文件；
  // regions 支持扁平数组 [{left,top,right,bottom}]、JSON 字符串或 detect-subtitles 的完整响应对象
  const runRemove = (videoPath: string, fileInfo: Record<string, unknown>) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const pick = (k: string) => body[k] ?? req.query?.[k];
    try {
      if (!fs.existsSync(WM_PYTHON)) {
        res.status(500).json({
          success: false,
          error: `VSR python not found: ${WM_PYTHON}. Create .vsrenv and install dependencies first.`,
          file: fileInfo,
        });
        return;
      }

      const jobId = uuidv4();
      const relDir = path.posix.join("video", "no-watermark", jobId);
      const outDir = path.resolve(PUBLIC_DIR, relDir);
      fs.mkdirSync(outDir, { recursive: true });
      const outName = "no_watermark.mp4";
      const outPath = path.resolve(outDir, outName);

      const args = [
        WM_SCRIPT,
        videoPath,
        "--out", outPath,
        "--device", String(pick("device") || "auto"),
        "--deviation", String(numOpt(pick("deviation"), 10)),
        "--max-load-num", String(numOpt(pick("maxLoadNum"), 50)),
        "--neighbor-stride", String(numOpt(pick("neighborStride"), 5)),
        "--ref-length", String(numOpt(pick("refLength"), 10)),
      ];

      // regions 可为数组、JSON 字符串或 {regions:[...]}；脚本内部统一归一化
      const regions = pick("regions");
      if (regions !== undefined && regions !== null) {
        const regionStr = typeof regions === "string" ? regions : JSON.stringify(regions);
        if (regionStr && regionStr !== "null") args.push("--regions", regionStr);
      }

      execFile(
        WM_PYTHON,
        args,
        { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60 * 1000 },
        (err, stdout, stderr) => {
          // 脚本始终向 stdout 打印单个 JSON 对象（VSR 的进度输出已重定向到 stderr）
          let parsed: any = null;
          try {
            parsed = JSON.parse(String(stdout).trim());
          } catch {
            /* ignore */
          }
          if (parsed && parsed.success) {
            const outExists = fs.existsSync(outPath);
            res.json({
              ...parsed,
              file: fileInfo,
              video: {
                ...(parsed.video || {}),
                filename: outExists ? `${relDir}/${outName}` : null,
                url: outExists ? `/static/${relDir}/${outName}` : null,
                sizeBytes: outExists ? fs.statSync(outPath).size : 0,
              },
            });
            return;
          }
          const message =
            (parsed && parsed.error) ||
            (stderr && String(stderr).trim().split("\n").slice(-3).join(" | ")) ||
            (err ? err.message : "Watermark removal failed");
          const bad = typeof message === "string" && /cannot open|not found|no readable|no frames|invalid --regions/i.test(message);
          res.status(bad ? 400 : 500).json({ success: false, error: message, file: fileInfo });
        }
      );
    } catch (e) {
      console.error("Remove watermark error:", e);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e), file: fileInfo });
    }
  };

  const ctype = String(req.headers["content-type"] || "");
  if (ctype.includes("multipart/form-data")) {
    (req as any)._uploadDir = "uploads";
    fileUpload.single("file")(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
        } else {
          res.status(400).json({ success: false, error: err.message });
        }
        return;
      }
      if (!req.file) {
        res.status(400).json({ success: false, error: "No file uploaded. Use field name 'file'." });
        return;
      }
      const relPath = `uploads/${req.file.filename}`;
      runRemove(req.file.path, {
        filename: relPath,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/static/${relPath}`,
      });
    });
    return;
  }

  // 已有文件模式
  const filename = req.body?.filename || req.query?.filename;
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ success: false, error: "Provide a video via multipart field 'file' or 'filename'." });
    return;
  }
  const localPath = resolveLocalMediaPath(filename);
  if (!localPath) {
    res.status(404).json({ success: false, error: `Video not found: ${filename}` });
    return;
  }
  runRemove(localPath, { filename, size: fs.statSync(localPath).size });
});

// ========== 文本转语音（sherpa-onnx Supertonic 3，GPU 优先） ==========
// 复用项目内模型 sherpa-onnx-supertonic-3-tts-int8-2026-05-11 与隔离环境 .vsrenv，
// CUDA 运行库集中在项目内 .tts_cuda，不污染系统。默认走 GPU（device=cuda），
// 无 GPU 或 CUDA 不可用时脚本自动回退 CPU，并在响应 provider 字段中如实返回。
const TTS_PYTHON = process.env.TTS_PYTHON || path.resolve(".vsrenv/bin/python");
const TTS_SCRIPT = process.env.TTS_SCRIPT || path.resolve("python/tts.py");
const TTS_MODEL_DIR = process.env.TTS_MODEL_DIR || path.resolve("sherpa-onnx-supertonic-3-tts-int8-2026-05-11");

app.post("/api/tts", (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const pick = (k: string) => body[k] ?? req.query?.[k];

  const text = pick("text");
  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ success: false, error: "Provide non-empty 'text'." });
    return;
  }

  if (!fs.existsSync(TTS_PYTHON)) {
    res.status(500).json({
      success: false,
      error: `TTS python not found: ${TTS_PYTHON}. Create .vsrenv and install sherpa-onnx first.`,
    });
    return;
  }

  const jobId = uuidv4();
  const relDir = path.posix.join("audio", "tts", jobId);
  const outDir = path.resolve(PUBLIC_DIR, relDir);
  fs.mkdirSync(outDir, { recursive: true });
  const outName = "speech.wav";
  const outPath = path.resolve(outDir, outName);

  const sid = Math.max(0, Math.min(9, Math.round(numOpt(pick("sid"), 0))));
  const args = [
    TTS_SCRIPT,
    "--text", text,
    "--out", outPath,
    "--model-dir", TTS_MODEL_DIR,
    "--sid", String(sid),
    "--lang", String(pick("lang") || "en"),
    "--speed", String(numOpt(pick("speed"), 1.0)),
    "--num-steps", String(Math.max(1, Math.round(numOpt(pick("numSteps"), 8)))),
    "--device", String(pick("device") || "cuda"),
  ];

  execFile(
    TTS_PYTHON,
    args,
    { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    (err, stdout, stderr) => {
      // 脚本始终向 stdout 打印单个 JSON 对象
      let parsed: any = null;
      try {
        parsed = JSON.parse(String(stdout).trim());
      } catch {
        /* ignore */
      }
      if (parsed && parsed.success && fs.existsSync(outPath)) {
        res.json({
          success: true,
          text,
          provider: parsed.provider,
          fallback: !!parsed.fallback,
          sampleRate: parsed.sample_rate,
          duration: parsed.duration,
          sid: parsed.sid,
          lang: parsed.lang,
          audio: {
            filename: `${relDir}/${outName}`,
            url: `/static/${relDir}/${outName}`,
            sizeBytes: fs.statSync(outPath).size,
          },
        });
        return;
      }
      const message =
        (parsed && parsed.error) ||
        (stderr && String(stderr).trim().split("\n").slice(-3).join(" | ")) ||
        (err ? err.message : "TTS failed");
      res.status(500).json({ success: false, error: message });
    }
  );
});

// ========== 健康检查 ==========
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    bundleReady: bundleLocation !== null,
  });
});

// ========== 启动服务 ==========
async function start() {
  // 先启动 HTTP 服务，再异步打包 Remotion，保证 API 随服务一起立即可用；
  // 打包期间调用 /api/render 会返回 "Bundle not initialized yet"
  app.listen(PORT, () => {
    console.log(`🎬 Remotion Render API running on ${SERVER_URL}`);
    console.log(`   POST /api/upload         - Upload an image`);
    console.log(`   GET  /api/uploads        - List uploaded images`);
    console.log(`   POST /api/uploads/delete - Delete uploaded images`);
    console.log(`   POST /api/audio/upload   - Upload an audio file`);
    console.log(`   POST /api/relay-upload   - Relay upload (streams body to target URL)`);
    console.log(`   POST /api/audio/concat   - Concatenate multiple audio files`);
    console.log(`   POST /api/audio/split    - Split audio by novelty detection (segments <= maxDuration)`);
    console.log(`   GET  /api/audio          - List local audio files`);
    console.log(`   GET  /api/audio/:filename/duration - Get audio duration`);
    console.log(`   POST /api/render         - Render a video`);
    console.log(`   POST /api/video/insert   - Insert TTS audio + burned-in subtitles into a video by timeline`);
    console.log(`   POST /api/video/cut      - Cut a video into clips by time segments`);
    console.log(`   POST /api/video/crop     - Crop video borders (top/left/right/bottom)`);
    console.log(`   POST /api/video/split-av - Split a video into a silent video + audio WAV`);
    console.log(`   POST /api/cleanup        - Clean public/uploads/video/audio (keeps audio/music, audio/ref)`);
    console.log(`   POST /api/face/detect    - Detect face / no-face time segments (InsightFace)`);
    console.log(`   POST /api/transcribe     - Transcribe speech to SRT subtitles (faster-whisper)`);
    console.log(`   POST /api/remove-vocals  - Remove vocals (speech) from audio/video (Demucs)`);
    console.log(`   POST /api/video/detect-subtitles - Detect subtitle top edge (OpenCV)`);
    console.log(`   POST /api/video/remove-watermark  - Remove watermarks/subtitles within given regions (VSR sttn-auto)`);
    console.log(`   GET  /api/health         - Health check`);
  });

  // 打包失败不影响 API 运行，仅渲染相关功能不可用
  initBundle().catch((e) => {
    console.error("Bundle failed (render endpoints will report error):", e);
  });
}

start();
