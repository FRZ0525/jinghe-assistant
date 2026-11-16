
(function () {
  "use strict";

  const glyph = { scale: 3, psm: 7 };
  const ratioGlyph = { ...glyph, whitelist: "0123456789/" };
  const challengeColumns = [0.480, 0.576, 0.671, 0.776];

  async function openImage(file) {
    if (typeof window.createImageBitmap === "function") {
      try {
        const bitmap = await window.createImageBitmap(file);
        return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
      } catch {
        // Some mobile image codecs are only supported by the image element.
      }
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("无法读取截图。"));
        element.src = url;
      });
      return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }

  function marginSize(size, isDark, reverse) {
    const limit = Math.floor(size / 4);
    let count = 0;
    while (count < limit && isDark(reverse ? size - count - 1 : count)) count += 1;
    return count >= 3 && count < limit ? count : 0;
  }

  async function findContent(file) {
    const opened = await openImage(file);
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(1, 1600 / Math.max(opened.width, opened.height));
      canvas.width = Math.max(1, Math.round(opened.width * scale));
      canvas.height = Math.max(1, Math.round(opened.height * scale));
      const width = canvas.width;
      const height = canvas.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("无法检测截图边缘。");
      context.drawImage(opened.image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const dark = (x, y) => {
        const offset = (y * width + x) * 4;
        return pixels[offset + 3] < 20
          || (pixels[offset] <= 8 && pixels[offset + 1] <= 8 && pixels[offset + 2] <= 8);
      };
      const columns = Array.from({ length: 11 }, (_, index) => Math.floor((index + 1) * width / 12));
      const rows = Array.from({ length: 11 }, (_, index) => Math.floor((index + 1) * height / 12));
      const darkRow = (y) => columns.every((x) => dark(x, y));
      const darkColumn = (x) => rows.every((y) => dark(x, y));
      const top = marginSize(height, darkRow, false);
      const bottom = marginSize(height, darkRow, true);
      const left = marginSize(width, darkColumn, false);
      const right = marginSize(width, darkColumn, true);
      const contentWidth = (width - left - right) / width;
      const contentHeight = (height - top - bottom) / height;
      return {
        x: left / width,
        y: top / height,
        width: contentWidth,
        height: contentHeight,
        detailed: contentWidth * opened.width >= 1150 && contentHeight * opened.height >= 900,
      };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      opened.release();
    }
  }

  async function readRegions(file, progress, content, regions) {
    const engine = window.JingheOCR;
    if (typeof engine?.recognize !== "function") throw new Error("识别组件尚未准备好。");
    const projected = regions.map((region) => ({
      ...region,
      x: content.x + region.x * content.width,
      y: content.y + region.y * content.height,
      width: region.width * content.width,
      height: region.height * content.height,
    }));
    const result = await engine.recognize(file, progress, { regions: projected });
    return new Map(result.map(({ region, text }) => [region.id, text]));
  }

  function cleanName(value) {
    const line = typeof value === "string" ? value.trim() : "";
    const name = line.replace(/[\r\n]+/g, " ")
      .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1");
    return /[\p{L}\p{N}]/u.test(name) ? name : "";
  }

  function parseDigits(value, maxLength) {
    const reading = typeof value === "string" ? value.normalize("NFKC").replace(/\s/g, "") : "";
    return /^\d+$/.test(reading) && reading.length <= maxLength && Number(reading) > 0 ? reading : "";
  }

  async function readRoles(file, progress) {
    const content = await findContent(file);
    const numeric = { ...glyph, lightText: true, threshold: 177, whitelist: "0123456789" };
    const regions = [];
    for (let row = 0; row < 9; row += 1) {
      const offset = row * 0.0888;
      regions.push(
        { ...glyph, id: "name-" + row, x: row ? 0.132 : 0.109, y: 0.131 + offset, width: row ? 0.091 : 0.095, height: 0.023 },
        { ...numeric, id: "level-" + row, x: row ? 0.089 : 0.067, y: 0.132 + offset, width: 0.037, height: 0.032 },
        {
          ...numeric, id: "power-" + row, threshold: content.detailed ? 177 : 125,
          x: row ? 0.145 : 0.123, y: 0.150 + offset, width: 0.063, height: 0.023,
        }
      );
    }

    const results = await readRegions(file, progress, content, regions);
    const roles = [];
    for (let row = 0; row < 9; row += 1) {
      const character = cleanName(results.get("name-" + row));
      if (!character) continue;
      const level = parseDigits(results.get("level-" + row), 3);
      const power = parseDigits(results.get("power-" + row), 14);
      const role = { character };
      if (level) role.level = Number(level);
      if (power) role.power = power;
      roles.push(role);
    }
    return roles;
  }

  function nameKey(name) {
    return name.normalize("NFKC").replace(/\s/g, "").toLocaleLowerCase();
  }

  function catalogNames(catalog) {
    if (!Array.isArray(catalog)) return [];
    return Array.from(new Set(catalog.map((entry) => cleanName(typeof entry === "string" ? entry : entry?.name)).filter(Boolean)));
  }

  function oneCharacterOff(left, right) {
    const a = Array.from(left);
    const b = Array.from(right);
    return a.length >= 4 && a.length === b.length && a.filter((character, index) => character !== b[index]).length === 1;
  }

  function resolveRaid(value, catalog) {
    const reading = cleanName(value);
    if (!reading) return "";
    const key = nameKey(reading);
    const exact = catalog.find((name) => nameKey(name) === key);
    if (exact) return exact;
    const near = catalog.filter((name) => oneCharacterOff(key, nameKey(name)));
    return near.length === 1 ? near[0] : reading;
  }

  function parseReading(value) {
    const reading = typeof value === "string" ? value.normalize("NFKC").replace(/\s/g, "") : "";
    const match = reading.match(/^(\d{1,3})\/(\d{1,3})$/);
    if (!match || Number(match[2]) < 1 || Number(match[1]) > Number(match[2])) return "";
    return reading;
  }

  async function readChallenges(file, progress, { catalog } = {}) {
    const content = await findContent(file);
    const knownNames = catalogNames(catalog);
    const regions = [];
    for (const [column, center] of challengeColumns.entries()) {
      regions.push({
        ...glyph, id: "heading-" + column, x: center - 0.036, y: 0.331, width: 0.072, height: 0.028,
        scale: column === 2 ? 2.5 : 3,
      });
    }
    for (let row = 0; row < 4; row += 1) {
      const offset = row * 0.0653;
      regions.push({ ...glyph, id: "role-" + row, x: 0.221, y: 0.370 + offset, width: 0.114, height: 0.028 });
      for (const [column, center] of challengeColumns.entries()) {
        regions.push({
          ...ratioGlyph, id: "ratio-" + row + "-" + column,
          x: center - (content.detailed ? 0.0225 : 0.018),
          y: (content.detailed ? 0.3785 : 0.3805) + offset,
          width: content.detailed ? 0.045 : 0.036, height: content.detailed ? 0.025 : 0.021,
        });
      }
    }
    const results = await readRegions(file, progress, content, regions);
    const headings = challengeColumns.map((_, column) => resolveRaid(results.get("heading-" + column), knownNames));
    const keys = headings.map(nameKey);
    const names = [];
    for (const [column, raid] of headings.entries()) {
      if (raid && keys.indexOf(keys[column]) === column) names.push(raid);
    }
    const counts = [];
    for (let row = 0; row < 4; row += 1) {
      const character = cleanName(results.get("role-" + row));
      if (!character) continue;
      for (const [column, raid] of headings.entries()) {
        const key = keys[column];
        if (!raid || keys.indexOf(key) !== keys.lastIndexOf(key)) continue;
        const reading = parseReading(results.get("ratio-" + row + "-" + column));
        if (reading) counts.push({ character, raid, reading });
      }
    }
    return { names, counts };
  }

  window.JingheRosterLayout = { readRoles, readChallenges };
})();
