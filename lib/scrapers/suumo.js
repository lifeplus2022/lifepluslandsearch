const cheerio = require('cheerio');
const { resolvePrefSlug } = require('../prefectures');
const { extractListings, parseFields, matchesCriteria, formatAddressDisplay } = require('../extract');

const ORIGIN = 'https://suumo.jp';
const HREF_PATTERN = /\/tochi\/[a-z]+\/(?:sc_[a-z0-9]+\/)?nc_\d+\//;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// SUUMOの実際の検索画面の操作順を踏襲したフロー：
//   /tochi/<都道府県>/city/ から開始 → 市区郡にチェック → さらに町名を絞り込む
//   → 町村にチェック → 検索する → 結果一覧
// 各画面操作が呼び出している内部エンドポイントを直接呼ぶことで、
// ヘッドレスブラウザを使わずに同じ結果を得る。

async function fetchText(url, options = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9', ...(options.headers || {}) }
      });
      const text = await res.text();
      return { status: res.status, text };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 800 + attempt * 800));
    }
  }
  throw lastErr;
}

// 「市区郡にチェック」パネル（/tochi/<pref>/city/）から地域コード(ar/bs/ta)と市区郡一覧を取得
async function fetchAreaPage(prefSlug) {
  const { text } = await fetchText(`${ORIGIN}/tochi/${prefSlug}/city/`);
  const abt = text.match(/name="ar" value="(\d+)" id="jsiAr" \/><input type="hidden" name="bs" value="(\d+)" id="jsiBs" \/><input type="hidden" name="ta" value="(\d+)" id="jsiTa"/);
  const cityRe = /type="checkbox" name="sc" value="(\d+)" id="[^"]+" class="js-checkSingle" \/><label for="[^"]+">\s*([^<]+?)<span/g;
  const cities = [];
  let m;
  while ((m = cityRe.exec(text))) {
    cities.push({ code: m[1], name: m[2].trim() });
  }
  if (!abt) return null;
  return { ar: abt[1], bs: abt[2], ta: abt[3], cities };
}

// 「さらに町名を絞り込む」パネルから町村一覧（コード・名称）を取得
async function fetchTownList(area, cityCode) {
  const body = new URLSearchParams({
    ar: area.ar, bs: area.bs, cn: '9999999', et: '9999999', hb: '0', ht: '9999999',
    jj012fi20202Kbn: '3', kb: '1', kj: '9', km: '1', kt: '9999999', mb: '0', mt: '9999999',
    ni: '9999999', sc: cityCode, scTemp: cityCode, ta: area.ta, tb: '0', tt: '9999999',
    lbp: '/bukken/ichiran/JJ012FC001/'
  });
  const { text } = await fetchText(`${ORIGIN}/jj/bukken/common/JJ010FK003/lightboxMachi/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${ORIGIN}/tochi/` },
    body: body.toString()
  });
  const townRe = /name="oz" value="(\d+)" id="[^"]+" class="js-checkEkiError js-checkSingle"><label for="[^"]+">([^<]+?)<span/g;
  const towns = [];
  let m;
  while ((m = townRe.exec(text))) {
    towns.push({ code: m[1], name: m[2].trim() });
  }
  return towns;
}

// 一時的な通信不調で町村一覧が0件になることがあるため、空の場合は一度だけ再試行する
async function fetchTownListWithRetry(area, cityCode) {
  let towns = await fetchTownList(area, cityCode);
  if (towns.length === 0) {
    await new Promise(r => setTimeout(r, 1000));
    towns = await fetchTownList(area, cityCode);
  }
  return towns;
}

function buildListingUrl(area, cityCode, townCode) {
  const params = new URLSearchParams({
    ar: area.ar, bs: area.bs, ta: area.ta, sc: cityCode,
    cn: '9999999', et: '9999999', hb: '0', ht: '9999999',
    kb: '1', kj: '9', km: '1', kt: '9999999', mb: '0', mt: '9999999',
    ni: '9999999', pc: '20', pj: '1', po: '0', tb: '0', tt: '9999999'
  });
  if (townCode) params.set('oz', townCode);
  return `${ORIGIN}/jj/bukken/ichiran/JJ012FC001/?${params.toString()}`;
}

async function searchSuumo(criteria, _context) {
  const prefSlug = resolvePrefSlug(criteria.prefecture);
  if (!prefSlug) {
    return {
      site: 'SUUMO',
      url: 'https://suumo.jp/tochi/',
      error: '都道府県を指定してください（対応都道府県名と一致しません）',
      items: []
    };
  }

  let targetUrl = `${ORIGIN}/tochi/${prefSlug}/`;
  let warning = null;
  // サーバー側（SUUMO自身）で市区郡・町村が絞り込めた場合は、その分はクライアント側の
  // テキスト一致チェックを免除する。物件カードの表示テキストに市区郡名が
  // 含まれないことがあり、二重チェックすると誤って取りこぼすため。
  const filterCriteria = { ...criteria };

  try {
    if (criteria.city) {
      const area = await fetchAreaPage(prefSlug);
      if (area) {
        const city = area.cities.find(c => c.name.includes(criteria.city) || criteria.city.includes(c.name));
        if (city) {
          delete filterCriteria.city;
          let townCode = null;
          if (criteria.town) {
            const towns = await fetchTownListWithRetry(area, city.code);
            const town = towns.find(t => t.name.includes(criteria.town) || criteria.town.includes(t.name));
            if (town) {
              townCode = town.code;
              delete filterCriteria.town;
            } else {
              warning = `町村「${criteria.town}」の絞り込みに失敗したため、${criteria.city}全体の結果から該当物件を抽出しています。`;
            }
          }
          targetUrl = buildListingUrl(area, city.code, townCode);
        }
      }
    }
  } catch (err) {
    return { site: 'SUUMO', url: targetUrl, error: `市町村情報の取得に失敗しました: ${err.message}`, items: [] };
  }

  let collected = [];
  try {
    const { status, text } = await fetchText(targetUrl);
    if (status === 200) {
      const $ = cheerio.load(text);
      collected = extractListings($, HREF_PATTERN, ORIGIN, 60);
    }
  } catch (err) {
    return { site: 'SUUMO', url: targetUrl, error: `取得に失敗しました: ${err.message}`, items: [] };
  }

  const items = [];
  const seenUrls = new Set();
  for (const raw of collected) {
    if (seenUrls.has(raw.url)) continue;
    const fields = parseFields(raw.rawText);
    if (!matchesCriteria(raw, fields, filterCriteria)) continue;
    seenUrls.add(raw.url);
    items.push({
      url: raw.url,
      price: fields.price,
      area: fields.area,
      tsubo: fields.tsubo,
      address: formatAddressDisplay(fields.address, criteria, raw.rawText),
      access: fields.access
    });
    if (items.length >= 20) break;
  }

  return { site: 'SUUMO', url: targetUrl, error: null, warning, items };
}

module.exports = { searchSuumo };
