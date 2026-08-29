/**
 * 本地轻量存储（JSON 文件持久化）
 * 用于群活跃统计、播报游标等不依赖官网的数据。
 * 数据目录：<bot根>/data/
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function filePath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

/** 读取 JSON，不存在返回默认值 */
export function read<T>(name: string, fallback: T): T {
  try {
    ensureDir();
    const f = filePath(name);
    if (!fs.existsSync(f)) return fallback;
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** 写入 JSON */
export function write<T>(name: string, data: T): void {
  try {
    ensureDir();
    fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`[store] 写入 ${name} 失败:`, e);
  }
}

/** 简单取当天日期 YYYY-MM-DD */
export function todayStr(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
