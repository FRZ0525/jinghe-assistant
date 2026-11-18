
(function () {
  "use strict";

  const glyph = { scale: 3, psm: 7 };
  const ratioGlyph = { ...glyph, whitelist: "0123456789/" };
  const challengeColumns = [0.480, 0.576, 0.671, 0.776];
  const accountQuotaColumns = [0.383, ...challengeColumns];
  const alternateNameReads = [
    [/^server-name-\d+-\d+$/, { psm: 8, threshold: 124 }],
    [/^name-\d+$/, { scale: 1.5 }],
    [/^role-\d+$/, { scale: 1.5, threshold: 145 }],
  ];

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

  async function findContent(file, detectChallengeRows = false) {
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
      const croppedWidth = width - left - right;
      const croppedHeight = height - top - bottom;
      const contentWidth = croppedWidth / width;
      const contentHeight = croppedHeight / height;
      return {
        x: left / width,
        y: top / height,
        width: contentWidth,
        height: contentHeight,
        detailed: contentWidth * opened.width >= 1150 && contentHeight * opened.height >= 900,
        ...(detectChallengeRows ? {
          challengeRows: findChallengeRows(pixels, width, left, top, croppedWidth, croppedHeight),
        } : {}),
      };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      opened.release();
    }
  }

  function projectRegion(content, region) {
    return {
      ...region,
      x: content.x + region.x * content.width,
      y: content.y + region.y * content.height,
      width: region.width * content.width,
      height: region.height * content.height,
    };
  }

  async function readProjectedRegions(file, progress, regions) {
    const engine = window.JingheOCR;
    if (typeof engine?.recognize !== "function") throw new Error("识别组件尚未准备好。");
    const result = await engine.recognize(file, progress, { regions });
    return new Map(result.map(({ region, text, confidence }) => [region.id, { text, confidence }]));
  }

  function readRegions(file, progress, content, regions) {
    return readProjectedRegions(file, progress, regions.map((region) => projectRegion(content, region)));
  }

  function sourceRegions(content, regions) {
    const byId = new Map(regions.map((region) => [region.id, projectRegion(content, region)]));
    return (...ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  }

  function cleanName(value) {
    const line = typeof value === "string" ? value.trim() : "";
    const name = line.replace(/[\r\n]+/g, " ")
      .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1");
    return /[\p{L}\p{N}]/u.test(name) ? name : "";
  }

  function readName(value, regionId) {
    const name = cleanName(value);
    return regionId.startsWith("role-") ? name.replace(/^[,，:：\s]+/u, "") : name;
  }

  async function readRoleNames(file, progress, regions) {
    const crops = new Map();
    for (const region of regions) {
      const preset = alternateNameReads.find(([idPattern]) => idPattern.test(region.id));
      if (preset) crops.set(region.id, { ...region, ...preset[1] });
    }
    if (!crops.size) return new Map();
    const readings = await readProjectedRegions(file, progress, [...crops.values()]);
    const names = new Map();
    for (const [id, reading] of readings) {
      const name = readName(reading.text, id);
      if (name && name.length <= 40) names.set(id, name);
    }
    return names;
  }

  function parseDigits(value, maxLength) {
    const reading = typeof value === "string" ? value.normalize("NFKC").replace(/\s/g, "") : "";
    return /^\d+$/.test(reading) && reading.length <= maxLength && Number(reading) > 0 ? reading : "";
  }

  function levelRuns(pixels, width, height, startX, endX) {
    const edge = Math.max(1, Math.round(width * 0.00235));
    const minimum = Math.max(2, Math.round(width * 0.0047));
    const runs = [];
    let start = 0;
    const brightness = (index) => Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
    for (let y = Math.floor(height * 0.094); y < height * 0.951; y += 1) {
      let count = 0;
      for (let x = Math.floor(width * startX); x < width * endX; x += 1) {
        const index = (y * width + x) * 4;
        const light = brightness(index);
        if (light < 213 || Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) - light > 35) continue;
        if (brightness(index - edge * 4) < 153 || brightness(index + edge * 4) < 153) count += 1;
      }
      if (count >= minimum) {
        start ||= y;
      } else if (start) {
        if (y - start >= height * 0.011 && y - start <= height * 0.033) runs.push(start / height);
        start = 0;
      }
    }
    return runs;
  }

  function roleNameWidth(pixels, width, height, top, selected) {
    const edge = Math.max(1, Math.round(width * 0.00235));
    const gap = Math.max(3, Math.round(width * 0.007));
    const left = Math.floor(width * (selected ? 0.109 : 0.132));
    const right = Math.floor(width * (selected ? 0.227 : 0.253));
    const firstY = Math.floor(height * (top - 0.004));
    const lastY = Math.ceil(height * (top + 0.012));
    const brightness = (index) => Math.min(pixels[index], pixels[index + 1], pixels[index + 2]);
    let end = left;
    for (let x = left; x < right; x += 1) {
      if (x - end >= (end === left ? gap * 2 : gap)) break;
      for (let y = firstY; y < lastY; y += 1) {
        const index = (y * width + x) * 4;
        const light = brightness(index);
        if (light < 170 || Math.max(pixels[index], pixels[index + 1], pixels[index + 2]) - light > 43) continue;
        const dark = Math.min(brightness(index - edge * 4), brightness(index + edge * 4),
          brightness(index - edge * width * 4), brightness(index + edge * width * 4));
        if (light - dark >= 70) {
          end = x;
          break;
        }
      }
    }
    return end - left >= width * 0.01 ? (end - left + edge + 1) / width : 0.095;
  }

  async function locateRoleRows(file, content) {
    const opened = await openImage(file);
    const canvas = document.createElement("canvas");
    try {
      const width = opened.width * content.width;
      const height = opened.height * content.height;
      const scale = Math.min(1, 1600 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return [];
      context.drawImage(opened.image, opened.width * content.x, opened.height * content.y,
        width, height, 0, 0, canvas.width, canvas.height);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const regular = levelRuns(data, canvas.width, canvas.height, 0.089, 0.123);
      const selected = levelRuns(data, canvas.width, canvas.height, 0.065, 0.101);
      const pitch = 0.0888;
      const tolerance = 0.005;
      let matching = [];
      for (const start of regular) {
        const aligned = regular.filter((y) => {
          const steps = Math.round((y - start) / pitch);
          return Math.abs(y - start - steps * pitch) <= tolerance;
        });
        if (aligned.length > matching.length) matching = aligned;
      }
      if (matching.length < 2) return [];

      const rows = [];
      const offset = matching[0];
      for (let y = offset - Math.floor((offset - 0.094) / pitch) * pitch; y + 0.031 < 0.953; y += pitch) {
        const regularY = matching.find((value) => Math.abs(value - y) <= tolerance);
        const selectedY = selected.find((value) => Math.abs(value - y) <= tolerance);
        if (regularY !== undefined) rows.push({ top: regularY, selected: false });
        else if (selectedY !== undefined) rows.push({ top: selectedY, selected: true });
      }
      return rows.map((row) => ({
        ...row,
        nameWidth: roleNameWidth(data, canvas.width, canvas.height, row.top, row.selected),
      }));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      opened.release();
    }
  }

  async function readRoles(file, progress, { review = false } = {}) {
    const content = await findContent(file);
    const located = await locateRoleRows(file, content);
    const rows = located.length ? located : Array.from({ length: 9 }, (_, row) => ({
      top: 0.138 + row * 0.0888,
      selected: row === 0,
    }));
    const numeric = { ...glyph, lightText: true, threshold: 177, whitelist: "0123456789" };
    const regions = [];
    for (const [row, { top, selected, nameWidth = 0.095 }] of rows.entries()) {
      regions.push(
        { ...glyph, id: "name-" + row, x: selected ? 0.109 : 0.132, y: top - 0.006, width: nameWidth, height: 0.024, scale: 2 },
        { ...numeric, id: "level-" + row, x: selected ? 0.067 : 0.089, y: top - 0.003, width: 0.037, height: 0.029 },
        {
          ...numeric, id: "power-" + row, threshold: content.detailed ? 177 : 125,
          x: selected ? 0.124 : 0.1475, y: top + 0.013, width: 0.058, height: 0.018,
        }
      );
    }

    const results = await readRegions(file, progress, content, regions);
    const roles = [];
    const locate = sourceRegions(content, regions);
    for (let row = 0; row < rows.length; row += 1) {
      const nameId = "name-" + row;
      const reading = results.get(nameId);
      const character = readName(reading?.text, nameId);
      const level = parseDigits(results.get("level-" + row)?.text, 3);
      const power = parseDigits(results.get("power-" + row)?.text, 14);
      if (!character && !(review && level && power)) continue;
      const role = { character };
      if (level) role.level = Number(level);
      if (power) role.power = power;
      if (review) {
        role.regions = locate(nameId, "level-" + row, "power-" + row);
        if (Number.isFinite(reading?.confidence)) role.nameConfidence = reading.confidence;
      }
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

  function findChallengeRows(pixels, stride, left, top, width, height) {
    const first = Math.ceil(height * 0.361);
    const last = Math.floor(height * 0.642);
    const columns = accountQuotaColumns.map((center) => [
      left + Math.floor(width * (center - 0.025)),
      left + Math.ceil(width * (center + 0.025)),
    ]);
    const gap = Math.max(2, Math.round(height * 0.003));
    const bands = [];
    for (let y = first; y <= last; y += 1) {
      let matchingColumns = 0;
      for (const [start, end] of columns) {
        let matchingPixels = 0;
        for (let x = start; x < end; x += 1) {
          const offset = ((y + top) * stride + x) * 4;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          if ((green - red > 35 && green - blue > 10) || (red - green > 40 && red - blue > 20)) {
            matchingPixels += 1;
          }
        }
        if (matchingPixels >= 2) matchingColumns += 1;
      }
      if (matchingColumns < 2) continue;
      const band = bands.at(-1);
      if (band && y - band.end <= gap) band.end = y;
      else bands.push({ start: y, end: y });
    }
    const rows = bands.filter(({ start, end }) => {
      const thickness = (end - start + 1) / height;
      return thickness >= 0.0075 && thickness <= 0.021 && start > first && end < last;
    }).map(({ start, end }) => (start + end) / (2 * height));
    if (rows.length && rows.length <= 4 && rows.every((y, index) => {
      const gap = y - rows[index - 1];
      return index === 0 || (gap >= 0.060 && gap <= 0.071);
    })) return rows;
    return Array.from({ length: 4 }, (_, index) => 0.393 + index * 0.0653);
  }

  async function readChallenges(file, progress, { catalog, includeQuotas = false, review = false } = {}) {
    const content = await findContent(file, true);
    const knownNames = catalogNames(catalog);
    const regions = [];
    for (const [column, center] of challengeColumns.entries()) {
      regions.push({
        ...glyph, id: "heading-" + column, x: center - 0.035, y: 0.335, width: 0.068, height: 0.022,
        darkText: true, threshold: 152,
      }, {
        ...glyph, id: "heading-wide-" + column, x: center - 0.036, y: 0.331, width: 0.072, height: 0.028,
        scale: column === 2 ? 2.5 : 3,
      });
    }
    for (const [row, centerY] of content.challengeRows.entries()) {
      regions.push({ ...glyph, id: "role-" + row, x: 0.2255, y: centerY - 0.0235, width: 0.113, height: 0.023, scale: 2,
        darkText: true, threshold: 151 });
      for (const [column, center] of challengeColumns.entries()) {
        regions.push({
          ...ratioGlyph, id: "ratio-" + row + "-" + column,
          x: center - 0.021,
          y: centerY - 0.013,
          width: 0.041, height: 0.026,
        });
      }
    }
    if (includeQuotas) {
      const footer = { ...glyph, x: 0.220, y: 0.647, width: 0.057, height: 0.020 };
      regions.push({ ...footer, id: "quota-label", lightText: true, threshold: 165 });
      regions.push({ ...footer, id: "quota-label-raw" });
      for (const [column, center] of accountQuotaColumns.entries()) {
        const width = column === 0 ? 0.070 : 0.052;
        regions.push({
          ...ratioGlyph, id: "quota-" + column, x: center - width / 2, y: 0.647, width, height: 0.020,
          lightText: true, threshold: content.detailed ? 172 : 158,
        });
      }
    }
    const results = await readRegions(file, progress, content, regions);
    const headings = challengeColumns.map((_, column) => {
      const readings = ["heading-wide-", "heading-"].map((prefix) => cleanName(results.get(prefix + column)?.text)).filter(Boolean);
      const exact = knownNames.find((name) => readings.some((reading) => nameKey(reading) === nameKey(name)));
      if (exact) return exact;
      if (review && readings.length === 2 && nameKey(readings[0]) !== nameKey(readings[1])) {
        const [wide, narrow] = readings.map((reading) => resolveRaid(reading, knownNames));
        if (wide === narrow) return wide;
      }
      const reading = readings.find((value) => /^[\p{Script=Han}]{2,}$/u.test(value)) ?? readings[0];
      return review ? reading || "" : resolveRaid(reading, knownNames);
    });
    const keys = headings.map(nameKey);
    const names = [];
    const locate = sourceRegions(content, regions);
    const namedRaids = [];
    for (const [column, raid] of headings.entries()) {
      if (raid && keys.indexOf(keys[column]) === column) {
        names.push(raid);
        if (review) namedRaids.push({ raid, regions: locate("heading-" + column) });
      }
    }
    const counts = [];
    for (const [row] of content.challengeRows.entries()) {
      const nameId = "role-" + row;
      const nameReading = results.get(nameId);
      const character = readName(nameReading?.text, nameId);
      if (!character && !review) continue;
      for (const [column, raid] of headings.entries()) {
        const key = keys[column];
        if (!raid || keys.indexOf(key) !== keys.lastIndexOf(key)) continue;
        const reading = parseReading(results.get("ratio-" + row + "-" + column)?.text);
        if (reading) {
          const count = { character, raid, reading };
          if (review) {
            count.regions = locate(nameId, "heading-" + column, "ratio-" + row + "-" + column);
            if (Number.isFinite(nameReading?.confidence)) count.nameConfidence = nameReading.confidence;
          }
          counts.push(count);
        }
      }
    }
    const result = review ? { names, namedRaids, counts } : { names, counts };
    if (!includeQuotas) return result;
    const quotas = [];
    const recognizedFooter = ["quota-label", "quota-label-raw"].some((id) => (
      /总计|合计/u.test(cleanName(results.get(id)?.text))
    ));
    if (recognizedFooter) {
      const total = parseReading(results.get("quota-0")?.text);
      if (total) quotas.push(review ? { raid: null, reading: total, regions: locate("quota-label", "quota-0") } : { raid: null, reading: total });
      for (const [column, raid] of headings.entries()) {
        const key = keys[column];
        if (!raid || keys.indexOf(key) !== keys.lastIndexOf(key)) continue;
        const reading = parseReading(results.get("quota-" + (column + 1))?.text);
        if (reading) {
          const quota = { raid, reading };
          if (review) quota.regions = locate("heading-" + column, "quota-" + (column + 1));
          quotas.push(quota);
        }
      }
    }
    return { ...result, quotas };
  }

  function serverStatusColor(red, green, blue) {
    return (red > 105 && red > green + 58 && red > blue + 42 && green < 155)
      || (red > 165 && green > 132 && green > blue + 75)
      || (green > 128 && green > red + 55 && green > blue + 45);
  }

  function serverStatusRows(pixels, width, height, center) {
    const left = Math.round(width * (center - 0.014));
    const right = Math.round(width * (center + 0.014));
    const firstY = Math.ceil(height * 0.17);
    const lastY = Math.floor(height * 0.98);
    const markers = [];
    let start = null;
    let firstX = right;
    let lastX = left;
    for (let y = firstY; y <= lastY; y += 1) {
      let hits = 0;
      for (let x = left; x < right && y < lastY; x += 1) {
        const index = 4 * (y * width + x);
        if (serverStatusColor(pixels[index], pixels[index + 1], pixels[index + 2])) {
          hits += 1;
          firstX = Math.min(firstX, x);
          lastX = Math.max(lastX, x);
        }
      }
      if (hits >= Math.max(2, width * 0.0015)) {
        if (start === null) start = y;
      } else {
        const length = start === null ? 0 : y - start;
        const markerWidth = lastX - firstX;
        if (length >= width * 0.005 && length <= width * 0.021
          && markerWidth >= width * 0.006 && markerWidth <= width * 0.022) {
          markers.push({ x: (firstX + lastX) / (2 * width), y: (start + y - 1) / (2 * height) });
        }
        start = null;
        firstX = right;
        lastX = left;
      }
    }
    return markers;
  }

  async function serverCardRegions(file, content) {
    const opened = await openImage(file);
    const canvas = document.createElement("canvas");
    try {
      const scale = Math.min(1, 1600 / Math.max(opened.width, opened.height));
      canvas.width = Math.max(1, Math.round(opened.width * content.width * scale));
      canvas.height = Math.max(1, Math.round(opened.height * content.height * scale));
      const { width, height } = canvas;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return [];
      context.drawImage(opened.image, opened.width * content.x, opened.height * content.y,
        opened.width * content.width, opened.height * content.height, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const defaults = [0.328, 0.675];
      const columns = defaults.map((center) => serverStatusRows(pixels, width, height, center));
      const visibleRows = [...columns[0], ...columns[1]].sort((left, right) => left.y - right.y);
      const aspect = width / height;
      const rowCenters = [];
      for (const { y } of visibleRows) {
        if (!rowCenters.length || y - rowCenters.at(-1) > aspect * 0.018) rowCenters.push(y);
      }
      if (rowCenters.length < 2) return [];
      const centers = columns.map((markers, column) => markers.length
        ? markers.reduce((sum, marker) => sum + marker.x, 0) / markers.length
        : defaults[column]);
      const regions = [];
      for (const [row, y] of rowCenters.entries()) {
        for (const [column, center] of centers.entries()) {
          const id = row + "-" + column;
          regions.push(
            { ...glyph, id: "server-name-" + id, x: center - 0.013, y: y - aspect * 0.0335, width: 0.174, height: aspect * 0.0235,
              darkText: true, threshold: 100 },
            { ...glyph, id: "server-zone-" + id, x: center + 0.0078, y: y - aspect * 0.009, width: 0.175, height: aspect * 0.0175 },
          );
        }
      }
      return regions;
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      opened.release();
    }
  }

  function serverZone(value) {
    const text = cleanName(value).normalize("NFKC").replace(/\s/g, "");
    const name = text.match(/^[\p{Script=Han}·]{1,22}(?:[\dOoIl]{1,3})?[服区]$/u)?.[0];
    return name?.replace(/([\dOoIl]+)(?=[服区]$)/u, (digits) => (
      digits.replace(/[Oo]/g, "0").replace(/[Il]/g, "1")
    )) ?? "";
  }

  async function readServerList(file, progress, { review = false } = {}) {
    const content = await findContent(file);
    const regions = await serverCardRegions(file, content);
    if (!regions.length) return [];
    const results = await readRegions(file, progress, content, regions);
    const locate = sourceRegions(content, regions);
    const cards = [];
    for (let index = 0; index < regions.length; index += 2) {
      const nameId = regions[index].id;
      const zoneId = regions[index + 1].id;
      const zone = serverZone(results.get(zoneId)?.text);
      const reading = results.get(nameId);
      const character = readName(reading?.text, nameId);
      if (!zone || (!character && !review)) continue;
      const card = { character, zone, regions: locate(nameId, zoneId) };
      if (Number.isFinite(reading?.confidence)) card.nameConfidence = reading.confidence;
      cards.push(card);
    }
    return cards;
  }

  window.JingheRosterLayout = { readRoles, readChallenges, readServerList, readRoleNames };
})();
