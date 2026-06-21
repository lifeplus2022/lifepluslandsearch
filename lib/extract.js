// HTMLから物件カードらしきブロックを汎用的に抜き出すユーティリティ
// サイトのクラス名変更に強くするため、詳細ページへのリンクパターンを起点に
// その周辺テキストから価格・面積・所在地を正規表現で抜き出す方式をとる。

// 「930万円」のような単純な表記だけでなく、SUUMOなどで見られる
// 「1505万6000円」（万の桁と円の桁が分かれている）形式にも対応する。
const PRICE_UNIT_SRC = '[\\d,]+万(?:[\\d,]+)?円';

function extractListings($, hrefPattern, origin, maxItems = 40) {
  const seen = new Set();
  const items = [];

  $('a').each((_, el) => {
    if (items.length >= maxItems) return;
    const href = $(el).attr('href');
    if (!href || !hrefPattern.test(href)) return;
    const full = href.startsWith('http') ? href : origin + href;
    if (seen.has(full)) return;

    // 価格と面積の両方が見つかる最小の祖先ブロックを探す。
    // 見つかった時点で止めることで、複数カードのテキストが混ざるのを防ぐ。
    let block = $(el);
    let text = block.text().replace(/\s+/g, ' ').trim();
    const hasPriceRe = new RegExp(PRICE_UNIT_SRC);
    for (let d = 0; d < 12; d++) {
      const hasPrice = hasPriceRe.test(text);
      const hasArea = /[\d.]+\s*(?:m²|㎡|m2)/.test(text);
      if (hasPrice && hasArea) break;
      const parent = block.parent();
      if (!parent.length) break;
      block = parent;
      text = block.text().replace(/\s+/g, ' ').trim();
      if (text.length > 1500) break; // 親をたどりすぎて無関係な領域に入ったら諦める
    }
    if (text.length < 10 || text.length > 1500) return;

    seen.add(full);
    items.push({ url: full, rawText: text });
  });

  return items;
}

function parsePriceMan(text) {
  const m = text.match(/([\d,]+)万([\d,]+)?円/);
  if (!m) return null;
  const man = parseInt(m[1].replace(/,/g, ''), 10);
  const yen = m[2] ? parseInt(m[2].replace(/,/g, ''), 10) : 0;
  return man + yen / 10000;
}

function parseAreaSqm(text) {
  const m = text.match(/([\d.]+)\s*(?:m²|㎡|m2)/);
  return m ? parseFloat(m[1]) : null;
}

function parseFields(rawText) {
  const priceMatch = rawText.match(new RegExp(`${PRICE_UNIT_SRC}(?:\\s*[~〜]\\s*${PRICE_UNIT_SRC})?`));
  const areaMatch = rawText.match(/[\d.]+\s*(?:m²|㎡|m2)(?:\s*[~〜]\s*[\d.]+\s*(?:m²|㎡|m2))?/);
  const tsuboMatch = rawText.match(/[\d.]+坪/);
  const addressMatch = rawText.match(/(?:[ぁ-んァ-ヶ一-龥]{2,6}[都道府県])?[ぁ-んァ-ヶ一-龥]{1,8}(?:市|町|村|区)[ぁ-んァ-ヶ一-龥0-9０-９丁目番地号\-－]{0,20}/);
  const accessMatch = rawText.match(/[「『][^」』]{2,15}[」』]駅\s*徒歩\s*\d+分/);

  return {
    price: priceMatch ? priceMatch[0] : '不明',
    area: areaMatch ? areaMatch[0] : '不明',
    tsubo: tsuboMatch ? tsuboMatch[0] : '',
    address: addressMatch ? addressMatch[0] : '不明',
    access: accessMatch ? accessMatch[0] : '',
    priceMan: parsePriceMan(rawText),
    areaSqm: parseAreaSqm(rawText)
  };
}

function matchesCriteria(item, fields, criteria) {
  const haystack = item.rawText;

  if (criteria.city && !haystack.includes(criteria.city)) return false;
  if (criteria.town && !haystack.includes(criteria.town)) return false;

  if (criteria.areaMin && fields.areaSqm != null && fields.areaSqm < Number(criteria.areaMin)) return false;
  if (criteria.areaMax && fields.areaSqm != null && fields.areaSqm > Number(criteria.areaMax)) return false;

  if (criteria.priceMin && fields.priceMan != null && fields.priceMan < Number(criteria.priceMin)) return false;
  if (criteria.priceMax && fields.priceMan != null && fields.priceMan > Number(criteria.priceMax)) return false;

  return true;
}

// 住所文字列の先頭から都道府県名・市郡名を取り除き、町村・丁目以降だけを残す
function formatAddressDisplay(address, criteria, rawText) {
  // 「星岡」のように市区町村の接尾語（市町村区）を持たない地名は通常の住所
  // 正規表現では捉えられないため、検索条件の町村名が本文に含まれていれば
  // それを丁目・番地などの続きとあわせて優先的に表示する。
  if (criteria.town && rawText && rawText.includes(criteria.town)) {
    const idx = rawText.indexOf(criteria.town);
    const tail = rawText.slice(idx, idx + criteria.town.length + 12).match(/^[ぁ-んァ-ヶ一-龥0-9０-９丁目番地号\-－]+/);
    if (tail) return tail[0];
  }

  if (!address || address === '不明') return address;
  let display = address;
  if (criteria.prefecture) display = display.split(criteria.prefecture).join('');
  if (criteria.city) display = display.split(criteria.city).join('');
  display = display.replace(/^[ぁ-んァ-ヶ一-龥]{2,6}[都道府県]/, '');
  display = display.replace(/^[ぁ-んァ-ヶ一-龥]{1,8}(?:市|郡)/, '');
  display = display.trim();
  return display || address;
}

module.exports = { extractListings, parseFields, matchesCriteria, formatAddressDisplay };
