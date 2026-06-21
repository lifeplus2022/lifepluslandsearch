const express = require('express');
const path = require('path');
const { searchSuumo } = require('./lib/scrapers/suumo');
const { searchAthome } = require('./lib/scrapers/athome');
const { searchPocket3puku } = require('./lib/scrapers/pocket3puku');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/search', async (req, res) => {
  const criteria = {
    prefecture: (req.body.prefecture || '').trim(),
    city: (req.body.city || '').trim(),
    town: (req.body.town || '').trim()
  };

  if (!criteria.prefecture && !criteria.city && !criteria.town) {
    return res.status(400).json({ error: '検索条件を1つ以上入力してください。' });
  }
  if (!criteria.prefecture) {
    return res.status(400).json({ error: '都道府県は必須です（市町村の絞り込みのため）。' });
  }

  try {
    const [suumoResult, athomeResult, pocket3pukuResult] = await Promise.all([
      searchSuumo(criteria),
      searchAthome(criteria),
      searchPocket3puku(criteria)
    ]);
    res.json({ results: [suumoResult, athomeResult, pocket3pukuResult] });
  } catch (err) {
    res.status(500).json({ error: `検索中にエラーが発生しました: ${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`売り土地検索アプリ起動: http://localhost:${PORT}`);
});
