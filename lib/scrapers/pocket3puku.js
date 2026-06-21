const cheerio = require('cheerio');
const { matchesCriteria, formatAddressDisplay } = require('../extract');

const ORIGIN = 'https://www.pocket3puku.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 三福売買ステームの検索ページ（/sale/search）はフリーワード検索（fw）が
// 市区郡・町村名をそのまま受け付けるため、都道府県・市区郡・町村を
// スペース区切りで渡すだけで該当エリアの物件一覧を取得できる。

function parseItem($, el) {
  const $el = $(el);
  const link = $el.find('.bk-title a').first();
  const href = link.attr('href');
  if (!href) return null;
  const url = href.startsWith('http') ? href : `${ORIGIN}${href}`;

  const priceNum = $el.find('.kakaku .value .num').first().text().trim();
  const priceMan = priceNum ? parseInt(priceNum.replace(/,/g, ''), 10) : null;
  const areaText = $el.find('.men .value').first().text().trim();
  const areaSqm = areaText ? parseFloat(areaText) : null;
  const address = $el.find('.ad-kotu .ad a').first().text().trim();
  const access = $el.find('.ad-kotu .kotu .kotu_value').first().text().trim();
  const tsubo = $el.find('.tubo_tanka .value').first().text().trim();

  return {
    url,
    rawText: `${address} ${access}`,
    price: priceMan != null ? `${priceMan.toLocaleString()}万円` : '不明',
    area: areaText || '不明',
    tsubo,
    address: address || '不明',
    access,
    priceMan,
    areaSqm
  };
}

async function searchPocket3puku(criteria) {
  const keywords = [criteria.prefecture, criteria.city, criteria.town].filter(Boolean).join(' ');
  if (!keywords) {
    return {
      site: '三福売買ステーション',
      url: `${ORIGIN}/sale/search`,
      error: '検索条件（都道府県・郡市・町村のいずれか）を入力してください',
      items: []
    };
  }

  const url = `${ORIGIN}/sale/result?fw=${encodeURIComponent(keywords)}`;

  let html;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9' } });
    if (res.status !== 200) {
      return { site: '三福売買ステーション', url, error: `取得に失敗しました（status ${res.status}）`, items: [] };
    }
    html = await res.text();
  } catch (err) {
    return { site: '三福売買ステーション', url, error: `取得に失敗しました: ${err.message}`, items: [] };
  }

  const $ = cheerio.load(html);
  const rawItems = [];
  $('.result-item').each((_, el) => {
    const item = parseItem($, el);
    if (item) rawItems.push(item);
  });

  const items = [];
  const seenUrls = new Set();
  for (const raw of rawItems) {
    if (seenUrls.has(raw.url)) continue;
    const fields = { areaSqm: raw.areaSqm, priceMan: raw.priceMan };
    if (!matchesCriteria(raw, fields, criteria)) continue;
    seenUrls.add(raw.url);
    items.push({
      url: raw.url,
      price: raw.price,
      area: raw.area,
      tsubo: raw.tsubo,
      address: formatAddressDisplay(raw.address, criteria, raw.rawText),
      access: raw.access
    });
    if (items.length >= 20) break;
  }

  return { site: '三福売買ステーション', url, error: null, items };
}

module.exports = { searchPocket3puku };
