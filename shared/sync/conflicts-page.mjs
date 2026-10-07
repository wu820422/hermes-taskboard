export function conflictsPage() {
  return `<!doctype html>
<meta charset="utf-8">
<title>同步衝突</title>
<style>
  body { font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; background: #f6f4ef; color: #1c1915; }
  main { max-width: 880px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 28px; margin-bottom: 8px; }
  p.lead { color: #5c564c; }
  article { background: white; border: 1px solid #e4ddd0; border-radius: 12px; padding: 16px 18px; margin: 12px 0; }
  .meta { color: #6b645a; font-size: 13px; }
  pre { white-space: pre-wrap; background: #f3efe7; padding: 8px 10px; border-radius: 8px; }
  button { margin-right: 8px; padding: 8px 12px; border-radius: 8px; border: 1px solid #1c1915; background: #1c1915; color: white; }
  button.secondary { background: white; color: #1c1915; }
  .empty { padding: 28px; text-align: center; color: #6b645a; }
</style>
<main>
  <h1>同步衝突</h1>
  <p class="lead">同一欄位在兩邊都改過時，不會自動覆蓋。請選擇要留下的值。套用失敗的變更會留在下面，下一輪同步再試，不會擋住其他變更。</p>
  <div id="list">載入中…</div>
</main>
<script>
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}
async function load() {
  const response = await fetch('/api/sync/conflicts');
  const payload = await response.json();
  const root = document.querySelector('#list');
  const conflicts = payload.conflicts ?? [];
  const rejected = payload.rejected ?? [];
  if (!response.ok) {
    root.textContent = payload.error?.message ?? '無法載入衝突';
    return;
  }
  const conflictHtml = conflicts.length === 0
    ? '<div class="empty">目前沒有未解決的衝突。</div>'
    : conflicts.map((conflict) => \`
    <article data-id="\${escapeHtml(conflict.id)}">
      <strong>\${escapeHtml(conflict.entity_type)}</strong> · \${escapeHtml(conflict.entity_id)} · \${escapeHtml(conflict.field)}
      <div class="meta">\${escapeHtml(conflict.created_at)}</div>
      <p>本機</p><pre>\${escapeHtml(conflict.local_value_json)}</pre>
      <p>遠端</p><pre>\${escapeHtml(conflict.remote_value_json)}</pre>
      <button data-choice="local">留下本機</button>
      <button class="secondary" data-choice="remote">採用遠端</button>
    </article>
  \`).join('');
  const rejectedHtml = rejected.length === 0 ? '' : \`
    <h2>尚未套用的變更</h2>
    \${rejected.map((item) => \`
      <article>
        <strong>\${escapeHtml(item.op)}</strong> · \${escapeHtml(item.entity_type)} · \${escapeHtml(item.entity_id)}
        <div class="meta">\${escapeHtml(item.direction)} · 已試 \${escapeHtml(item.attempts)} 次 · \${escapeHtml(item.updated_at)}</div>
        <pre>\${escapeHtml(item.reason)}</pre>
      </article>
    \`).join('')}
  \`;
  root.innerHTML = conflictHtml + rejectedHtml;
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-choice]');
  if (!button) return;
  const article = button.closest('article');
  await fetch('/api/sync/conflicts/' + encodeURIComponent(article.dataset.id) + '/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ choice: button.dataset.choice }),
  });
  await load();
});
load();
</script>`;
}
