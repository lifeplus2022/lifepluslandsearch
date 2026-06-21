const form = document.getElementById('searchForm');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const searchBtn = document.getElementById('searchBtn');

const SITE_CLASS = { 'SUUMO': 'suumo', 'アットホーム': 'athome', '三福売買ステーション': 'pocket3puku' };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  statusEl.className = '';
  statusEl.innerHTML = '<span class="spinner"></span>SUUMO・アットホームを検索中です（数十秒かかる場合があります）…';
  resultsEl.innerHTML = '';
  searchBtn.disabled = true;

  const payload = {
    prefecture: document.getElementById('prefecture').value,
    city: document.getElementById('city').value,
    town: document.getElementById('town').value
  };

  try {
    const res = await fetch('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();

    if (!res.ok) {
      statusEl.className = 'error';
      statusEl.textContent = data.error || '検索に失敗しました。';
      return;
    }

    statusEl.textContent = '検索が完了しました。';
    renderResults(data.results);
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = `通信エラーが発生しました: ${err.message}`;
  } finally {
    searchBtn.disabled = false;
  }
});

function renderResults(results) {
  resultsEl.innerHTML = '';
  results.forEach(site => {
    const section = document.createElement('div');
    section.className = 'site-section';

    const cls = SITE_CLASS[site.site] || '';
    const header = document.createElement('div');
    header.className = `site-header ${cls}`;
    header.innerHTML = `<span>${escapeHtml(site.site)} の検索結果</span><a href="${site.url}" target="_blank" rel="noopener">サイトを直接見る ↗</a>`;
    section.appendChild(header);

    const body = document.createElement('div');
    body.className = 'site-body';

    if (site.error) {
      const note = document.createElement('div');
      note.className = 'site-note';
      note.textContent = site.error;
      body.appendChild(note);
    } else {
      if (site.warning) {
        const warn = document.createElement('div');
        warn.className = 'site-note';
        warn.textContent = site.warning;
        body.appendChild(warn);
      }
      if (!site.items || site.items.length === 0) {
        const note = document.createElement('div');
        note.className = 'site-note';
        note.textContent = '指定の条件に合う掲載物件が見つかりませんでした。';
        body.appendChild(note);
      } else {
        body.appendChild(buildTable(site.items));
      }
    }

    section.appendChild(body);
    resultsEl.appendChild(section);
  });
}

function buildTable(items) {
  const table = document.createElement('table');
  table.innerHTML = `
    <thead>
      <tr>
        <th>所在地</th>
        <th>価格</th>
        <th>面積</th>
        <th>アクセス</th>
        <th>詳細</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector('tbody');

  items.forEach(item => {
    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${escapeHtml(item.address)}</td>
      <td>${escapeHtml(item.price)}${item.tsubo ? ' / ' + escapeHtml(item.tsubo) : ''}</td>
      <td>${escapeHtml(item.area)}</td>
      <td>${escapeHtml(item.access || '-')}</td>
      <td><a class="detail-link" href="${item.url}" target="_blank" rel="noopener">物件を見る ↗</a></td>
    `;
    tbody.appendChild(tr);
  });

  return table;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
