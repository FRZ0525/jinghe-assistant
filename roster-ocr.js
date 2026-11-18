
(function () {
  "use strict";

  const stages = new Map([
    ["loading tesseract core", [0.03, 0.14]],
    ["initializing tesseract", [0.14, 0.25]],
    ["loading language traineddata", [0.25, 0.53]],
    ["initializing api", [0.53, 0.64]],
  ]);
  let runtimePromise;

  function loadRuntime(assetBase) {
    if (runtimePromise) return runtimePromise;
    runtimePromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const fail = () => {
        clearTimeout(timeout);
        script.remove();
        reject(new Error("无法载入本地识别组件。"));
      };
      const timeout = setTimeout(fail, 20000);
      script.src = new URL("tesseract.min.js", assetBase).href;
      script.async = true;
      script.onload = () => {
        if (typeof window.Tesseract?.createWorker !== "function") {
          fail();
          return;
        }
        clearTimeout(timeout);
        resolve(window.Tesseract);
      };
      script.onerror = fail;
      document.head.append(script);
    }).catch((error) => {
      runtimePromise = undefined;
      throw error;
    });
    return runtimePromise;
  }

  async function openImage(file) {
    if (typeof window.createImageBitmap === "function") {
      try {
        const bitmap = await window.createImageBitmap(file);
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
        };
      } catch {
        // Fall back to the image element for codecs unsupported by createImageBitmap.
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("无法读取截图尺寸。"));
        element.src = url;
      });
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => URL.revokeObjectURL(url),
      };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function pixelRectangle(region, dimensions) {
    const { x, y, width, height } = region;
    if (![x, y, width, height].every(Number.isFinite)
      || x < 0 || y < 0 || x >= 1 || y >= 1 || width <= 0 || height <= 0) {
      throw new RangeError("截图识别范围无效。");
    }
    const left = Math.floor(x * dimensions.width);
    const top = Math.floor(y * dimensions.height);
    const right = Math.min(dimensions.width, Math.ceil((x + width) * dimensions.width));
    const bottom = Math.min(dimensions.height, Math.ceil((y + height) * dimensions.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  function cropForRecognition(image, rectangle, scale, textTone, threshold) {
    const { left, top, width, height } = rectangle;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: Boolean(textTone) });
    if (!context) throw new Error("无法裁切截图。");
    context.imageSmoothingQuality = "high";
    context.fillStyle = textTone === "light" ? "#000" : "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image.source, left, top, width, height, 0, 0, canvas.width, canvas.height);

    if (textTone) {
      const limit = Number.isFinite(threshold) ? Math.min(255, Math.max(0, threshold)) : 165;
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imageData.data;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const brightness = (pixels[offset] * 299 + pixels[offset + 1] * 587 + pixels[offset + 2] * 114) / 1000;
        const isText = textTone === "light" ? brightness >= limit : brightness <= limit;
        const value = isText ? 0 : 255;
        pixels[offset] = value;
        pixels[offset + 1] = value;
        pixels[offset + 2] = value;
      }
      context.putImageData(imageData, 0, 0);
    }

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob);
        else reject(new Error("无法生成截图裁切区域。"));
      }, "image/png");
    });
  }

  async function recognize(file, progress, options = {}) {
    if (!(file instanceof Blob) || file.size === 0) {
      throw new TypeError("请选择有效的截图。");
    }
    let lastProgress = -1;
    const report = (value) => {
      const ratio = Math.min(1, Math.max(0, value));
      if (ratio <= lastProgress) return;
      lastProgress = ratio;
      if (typeof progress === "function") progress(ratio);
    };
    report(0);

    const regionMode = Array.isArray(options.regions);
    if (regionMode && options.regions.length === 0) {
      report(1);
      return [];
    }
    const image = regionMode ? await openImage(file) : null;
    try {
      const tasks = regionMode
        ? options.regions.map((region) => ({ region, rectangle: pixelRectangle(region, image) }))
        : [{}];
      const results = await recognizeTasks(file, options, image, tasks, report);
      return regionMode ? results : results[0].text;
    } finally {
      image?.close();
    }
  }

  async function recognizeTasks(file, options, image, tasks, report) {
    const assetBase = new URL("./ocr/", document.baseURI);
    const engine = await loadRuntime(assetBase);
    report(0.03);

    let regionIndex = 0;
    let worker;
    let timeout;
    const workerFailure = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("本地识别超时，请重试。")), 150000);
    });
    let rejectWorker;
    const reportedFailure = new Promise((_, reject) => { rejectWorker = reject; });
    const run = (job) => Promise.race([job, workerFailure, reportedFailure]);
    const opening = engine.createWorker(["chi_sim", "eng"], engine.OEM.LSTM_ONLY, {
      workerPath: new URL("worker.min.js", assetBase).href,
      corePath: assetBase.href,
      langPath: assetBase.href.replace(/\/$/, ""),
      workerBlobURL: false,
      cachePath: "jinghe-ocr-v6-best-int-v1",
      logger({ status, progress: value }) {
        if (!Number.isFinite(value)) return;
        if (status === "recognizing text") {
          report(0.65 + 0.34 * (regionIndex + value) / tasks.length);
          return;
        }
        const range = stages.get(status);
        if (range) report(range[0] + (range[1] - range[0]) * value);
      },
      errorHandler(error) {
        rejectWorker(error instanceof Error ? error : new Error(String(error)));
      },
    });

    try {
      worker = await run(opening);
      report(0.65);
      const results = [];
      for (const { region, rectangle } of tasks) {
        const mode = String(region?.psm ?? options.psm ?? engine.PSM.SINGLE_BLOCK);
        const whitelist = String(region?.whitelist ?? options.whitelist ?? "");
        await run(worker.setParameters({ tessedit_pageseg_mode: mode, tessedit_char_whitelist: whitelist }));
        const scale = Number.isFinite(region?.scale) ? Math.min(3, Math.max(1, region.scale)) : 1;
        const textTone = region?.lightText ? "light" : region?.darkText ? "dark" : "";
        const shouldCrop = rectangle && (scale > 1 || textTone);
        const recognitionImage = shouldCrop
          ? await run(cropForRecognition(image, rectangle, scale, textTone, region.threshold))
          : file;
        const recognitionOptions = rectangle && !shouldCrop ? { rectangle } : {};
        const { data } = await run(worker.recognize(recognitionImage, recognitionOptions));
        results.push({ text: data.text, confidence: data.confidence, region });
        regionIndex += 1;
        report(0.65 + 0.34 * regionIndex / tasks.length);
      }
      report(1);
      return results;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
      if (worker) {
        await worker.terminate();
      } else {
        // A worker may finish opening after the timeout.
        opening.then((lateWorker) => lateWorker.terminate(), () => {}).catch(() => {});
      }
    }
  }

  window.JingheOCR = { recognize };
})();
