#!/usr/bin/env node
/**
 * 跃马车队 · 英文新闻素材抓取（GitHub Actions 版）
 *
 * 作用：每小时跑一次，抓 Motorsport 的 F1 RSS，清洗后写成 news.json，
 *       由 jsDelivr 分发（自带 CORS，前端可直接读，不需要任何代理）。
 *
 * 为什么不在浏览器里抓：motorsport.com 的 RSS 没有 CORS 头，浏览器读不到；
 * 而公共 CORS 代理 2026-10 起已全部失效（allorigins 520、rss2json 403、corsproxy 401）。
 *
 * ⚠️ 清洗规则必须与 js/f1.js 的 feedClean / FEED_BLOCK 保持一致，
 *    也与本机脚本 _dev/_fetch-f1-news.js 保持一致（回归 J 组逐条比对）。
 *    改规则时三处一起改，否则「本机抓的」「这里抓的」「前端兜底」三批素材口径会漂移。
 */

'use strict';

const FEED_URL = 'https://www.motorsport.com/rss/f1/news/';
const KEEP = 30;

/* 与 f1.js 的 FEED_BLOCK 一字不差 */
const BLOCK = [
  'dead', 'death', 'died', 'killed', 'fatal', 'funeral', 'hospital', 'surgery', 'cancer',
  'injury', 'injured', 'crash injury', 'concussion', 'political', 'politics', 'war',
  'sanction', 'protest', 'controversy', 'arrested', 'abuse', 'racism', 'scandal',
  'sacked', 'fired', 'lawsuit', 'banned', 'doping', 'betting'
];

function strip(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function blocked(t) {
  const s = String(t || '').toLowerCase();
  return BLOCK.some(w => s.indexOf(w) >= 0);
}

/* RSS 的 description 是截断的导语（结尾带 "... Keep reading"），
   先去掉续读尾巴，再回退到最后一个完整句，避免把半句话交给 AI 去「补」。 */
function clean(s) {
  let t = String(s || '').trim()
    .replace(/\s*\.{2,}\s*Keep reading\s*$/i, '')
    .replace(/\s*Keep reading\s*$/i, '')
    .trim();
  const m = t.match(/^[\s\S]*[.!?](?=\s|$)/);
  if (m && m[0].trim().length >= 30) t = m[0].trim();
  return t.slice(0, 900);
}

function pick(block, tag) {
  const m = String(block).match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? strip(m[1]) : '';
}

/* 与 f1.js 的 guidNum 同一算法：同一 guid 永远得到同一个数，
   前端的「最近 7 天推过就跳过」去重才能成立。 */
function guidNum(g) {
  let h = 5381;
  const s = String(g || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function parse(xml) {
  const items = String(xml || '').match(/<item[^>]*>([\s\S]*?)<\/item>/g) || [];
  const out = [];
  for (const raw of items) {
    const b = raw.replace(/^<item[^>]*>/, '').replace(/<\/item>$/, '');
    const title = pick(b, 'title');
    let link = pick(b, 'link');
    const desc = pick(b, 'description');
    const guid = pick(b, 'guid') || link || title;
    if (!title || !guid) continue;
    if (blocked(title) || blocked(desc)) continue;
    try { link = decodeURIComponent(link); } catch (e) { /* 保持原样 */ }
    const d = new Date(pick(b, 'pubDate'));
    out.push({
      id: guidNum(guid),
      guid: String(guid).slice(0, 300),
      title: title.slice(0, 300),
      summary: clean(desc).slice(0, 900),
      link: String(link).slice(0, 500),
      published_at: isNaN(d.getTime()) ? '' : d.toISOString()
    });
  }
  const seen = new Set();
  return out
    .filter(r => (seen.has(r.guid) ? false : (seen.add(r.guid), true)))
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))
    .slice(0, KEEP);
}

async function once() {
  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; prancing-horse-news/1.0)' }
  });
  if (!res.ok) throw new Error('源站返回 HTTP ' + res.status);
  const items = parse(await res.text());
  if (!items.length) throw new Error('解析结果为空，源站结构可能变了');
  return items;
}

async function main() {
  /* 源站偶发 5xx / 超时，重试一次再判死，避免一次抖动就让整小时断档 */
  let items;
  try {
    items = await once();
  } catch (e) {
    console.error('第 1 次失败：' + e.message + '，5 秒后重试');
    await new Promise(r => setTimeout(r, 5000));
    items = await once();
  }

  const payload = {
    updated_at: new Date().toISOString(),
    source: 'motorsport',
    count: items.length,
    items
  };
  require('fs').writeFileSync('news.json', JSON.stringify(payload, null, 1) + '\n');
  console.log('写入 news.json：' + items.length + ' 条，最新 ' + items[0].published_at);
}

main().catch(e => {
  console.error('抓取失败：' + e.message);
  process.exit(1);
});
