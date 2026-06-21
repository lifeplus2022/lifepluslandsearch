const cheerio = require('cheerio');
const { resolvePrefSlug } = require('../prefectures');
const { extractListings, parseFields, matchesCriteria, formatAddressDisplay } = require('../extract');

const ORIGIN = 'https://www.athome.co.jp';
const MAX_PAGES = 4;
const HREF_PATTERN = /\/tochi\/\d+\//;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_BASIC = 'kp299,kp120,kp001,kf001,ke001,kj001';

// アットホームの実際の検索画面の操作順を踏襲したフロー：
//   売土地 → 都道府県 → 地域から探す（市区郡を選ぶ） → 検索結果を見る
//   → 町名で絞り込む（町村を選ぶ） → 検索結果を見る → 一覧表示
// 上記の各画面が呼び出している内部API・URLを直接呼ぶことで、
// ヘッドレスブラウザでのクリック操作（bot検知に弱い）を使わずに同じ結果を得る。

const BLOCK_MARKERS = ['認証にご協力ください', '認証中', 'captcha', 'geetest'];
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 市区郡・町村一覧は頻繁に変わらないため24時間キャッシュ

// 市区郡一覧・町村一覧はBot検出に最もかかりやすいページのため、一度取得した
// 結果をメモリ上にキャッシュして再取得の頻度そのものを減らす。
const cityListCache = new Map(); // prefSlug -> { cities, expiresAt }
const townListCache = new Map(); // `${prefSlug}:${cityCode}` -> { towns, expiresAt }

function isBlocked(text) {
  return text.length < 20000 && BLOCK_MARKERS.some(marker => text.includes(marker));
}

function browserHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    ...extra
  };
}

async function fetchText(url, retries = 2, extraHeaders = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: browserHeaders(extraHeaders) });
    const text = await res.text();
    if (res.status === 200 && !isBlocked(text)) return { status: res.status, text, blocked: false };
    if (attempt < retries) await new Promise(r => setTimeout(r, 1500 + attempt * 1500));
  }
  return { status: 200, text: '', blocked: true };
}

// 「地域から探す」ページに埋め込まれている市区郡一覧（コード・ローマ字・都道府県コード）を取得
async function findCity(prefSlug, cityName) {
  const cached = cityListCache.get(prefSlug);
  let cities;
  if (cached && cached.expiresAt > Date.now()) {
    cities = cached.cities;
  } else {
    const { text, blocked } = await fetchText(`${ORIGIN}/tochi/${prefSlug}/city/`);
    if (blocked) {
      if (cached) {
        // ブロックされても古いキャッシュが残っていればそれを使う
        cities = cached.cities;
      } else {
        const err = new Error('アクセス制限（認証画面）により市区郡情報を取得できませんでした');
        err.blocked = true;
        throw err;
      }
    } else {
      const re = /"code":"(\d+)","roman":"([a-z]+)","name":"([^"]+)","lat":"[^"]*","lon":"[^"]*","kenCd":"(\d+)"/g;
      cities = [];
      const seen = new Set();
      let m;
      while ((m = re.exec(text))) {
        const [, code, roman, name, kenCd] = m;
        if (seen.has(code)) continue;
        seen.add(code);
        cities.push({ code, roman, name, kenCd });
      }
      cityListCache.set(prefSlug, { cities, expiresAt: Date.now() + CACHE_TTL_MS });
    }
  }
  if (!cityName) return { cities, match: null };
  const match = cities.find(c => c.name.includes(cityName) || cityName.includes(c.name));
  return { cities, match };
}

// 「町名で絞り込む」をクリックした際に呼ばれる内部APIから町村一覧を取得
async function findTown(prefSlug, city, townName) {
  const cacheKey = `${prefSlug}:${city.code}`;
  const cached = townListCache.get(cacheKey);
  let groups;
  if (cached && cached.expiresAt > Date.now()) {
    groups = cached.groups;
  } else {
    const url = `${ORIGIN}/csite-bff/sell-living/bukken/list/town?siteCd=00000&prefectureRoman=${prefSlug}&cityRoman=${city.roman}&seoNm=tochi&basicConditions=${DEFAULT_BASIC}&cityCds=${city.code}&prefectureCd=${city.kenCd}&AT_TIME=${Date.now()}`;
    const { status, text } = await fetchText(url, 2, { Accept: 'application/json, text/plain, */*', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors' });
    if (status !== 200) return cached ? cached.groups.flatMap(g => g.town || []).find(t => t.name.includes(townName) || townName.includes(t.name)) : null;
    try {
      const json = JSON.parse(text);
      groups = json?.data?.townInfo || [];
      townListCache.set(cacheKey, { groups, expiresAt: Date.now() + CACHE_TTL_MS });
    } catch {
      return cached ? cached.groups.flatMap(g => g.town || []).find(t => t.name.includes(townName) || townName.includes(t.name)) : null;
    }
  }
  for (const group of groups) {
    const found = (group.town || []).find(t => t.name.includes(townName) || townName.includes(t.name));
    if (found) return found;
  }
  return null;
}

async function searchAthome(criteria, _context) {
  const prefSlug = resolvePrefSlug(criteria.prefecture);
  if (!prefSlug) {
    return {
      site: 'アットホーム',
      url: 'https://www.athome.co.jp/tochi/',
      error: '都道府県を指定してください（対応都道府県名と一致しません）',
      items: []
    };
  }

  let baseUrl = `${ORIGIN}/tochi/${prefSlug}/list/`;
  let queryString = '';
  // サーバー側（アットホーム自身）で市区郡・町村が絞り込めた場合は、その分は
  // クライアント側のテキスト一致チェックを免除する（二重チェックでの取りこぼし防止）。
  const filterCriteria = { ...criteria };

  try {
    if (criteria.city) {
      const { match: city } = await findCity(prefSlug, criteria.city);
      if (city) {
        delete filterCriteria.city;
        const params = new URLSearchParams({ pref: city.kenCd, cities: city.roman, basic: DEFAULT_BASIC, kod: '', q: '1' });

        if (criteria.town) {
          const town = await findTown(prefSlug, city, criteria.town);
          if (town) {
            params.set('towns', town.code);
            delete filterCriteria.town;
          }
        }

        queryString = `?${params.toString()}`;
      }
    }
  } catch (err) {
    return { site: 'アットホーム', url: baseUrl, error: `市町村情報の取得に失敗しました: ${err.message}`, items: [] };
  }

  const collected = [];
  try {
    for (let p = 1; p <= MAX_PAGES; p++) {
      const pageUrl = p === 1
        ? `${baseUrl}${queryString}`
        : `${baseUrl}page${p}/${queryString}`;
      const { text, blocked } = await fetchText(pageUrl);
      if (blocked) {
        if (collected.length === 0) {
          return {
            site: 'アットホーム',
            url: `${baseUrl}${queryString}`,
            error: 'アットホーム側のアクセス制限（認証画面）により取得できませんでした。時間をおいて再度お試しください。',
            items: []
          };
        }
        break;
      }
      const $ = cheerio.load(text);
      const found = extractListings($, HREF_PATTERN, ORIGIN, 60);
      if (found.length === 0) break;
      collected.push(...found);
    }
  } catch (err) {
    return { site: 'アットホーム', url: `${baseUrl}${queryString}`, error: `取得に失敗しました: ${err.message}`, items: [] };
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

  return { site: 'アットホーム', url: `${baseUrl}${queryString}`, error: null, items };
}

module.exports = { searchAthome };
