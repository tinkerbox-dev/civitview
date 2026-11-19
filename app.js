'use strict';
/* CivitView — cliente móvil no oficial para ojear Civitai (solo lectura, API pública). */

const API = 'https://civitai.com/api/v1';
// Niveles de Civitai como bits: 1 PG · 2 PG-13 · 4 R · 8 X · 16 XXX
const LEVELS = [[1, 'Apto'], [2, 'Suave'], [4, 'Maduro'], [24, 'X']];
const ALL = 31, ADULT = 28;
const LV_STR = { None: 1, Soft: 2, Mature: 4, X: 8 };           // nsfwLevel en texto → número
// Modelos base de vídeo (nombres aceptados por la API)
const VIDEO_BASES = ['LTXV', 'LTXV2', 'LTXV 2.3', 'LTXV 2.5', 'Wan Video', 'Wan Video 3.0', 'Wan Video 1.3B t2v', 'Wan Video 14B t2v',
  'Wan Video 14B i2v 480p', 'Wan Video 14B i2v 720p', 'Wan Video 2.2 TI2V-5B', 'Wan Video 2.2 I2V-A14B', 'Wan Video 2.2 T2V-A14B',
  'Wan Video 2.5 I2V', 'Wan Video 2.5 T2V', 'Hunyuan Video', 'MiniMax H3', 'Seedance', 'Veo 3', 'Kling', 'Sora 2', 'Mochi', 'CogVideoX', 'SVD XT'];
const isVideoBase = b => !!b && (VIDEO_BASES.includes(b) || /video|ltxv|hunyuan|mochi|cogvideo|seedance|kling|sora|veo|hailuo|vidu/i.test(b));

/* ---------- utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
};
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
const store = {
  get(k, d) { try { const v = localStorage.getItem('civitview.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('civitview.' + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const nf = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });
const fmt = n => nf.format(n || 0);
const lc = s => (s || '').toLowerCase();
const splitTerms = s => lc(s).split(',').map(t => t.trim()).filter(Boolean);
const lines = s => lc(s).split(/[\n,]/).map(t => t.trim().replace(/^@/, '')).filter(Boolean);

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado'); } catch { toast('No se pudo copiar'); }
}

/* ---------- estado ---------- */
const S = {
  mask: store.get('mask', 1),                    // por defecto solo Apto
  blur: store.get('blur', false),
  imgF: store.get('imgF', {}),
  modF: store.get('modF', {}),
  sel: store.get('sel', {}),
};
const seenBaseModels = new Set();
S.cols = store.get('cols', 2);
const colCount = () => S.cols === 1 ? (innerWidth < 700 ? 1 : 2) : (innerWidth < 600 ? 2 : innerWidth < 900 ? 3 : 4);
const thumbW = () => colCount() === 1 ? 900 : 450;

const lvlNum = it => it.browsingLevel ?? (typeof it.nsfwLevel === 'number' ? it.nsfwLevel : LV_STR[it.nsfwLevel] || 1);
const allowed = it => (lvlNum(it) & S.mask) !== 0;
const modelAllowed = m => ((m.nsfwLevel || 1) & S.mask) !== 0;
const isAdult = it => lvlNum(it) >= 4;
const siteBase = () => (S.mask & ADULT) ? 'https://civitai.red' : 'https://civitai.com';

function media(url, width, type) {
  const seg = type === 'video' ? `transcode=true,width=${width}` : `width=${width}`;
  return url.replace(/\/(original=true|width=\d+|transcode=true[^/]*)\//, `/${seg}/`);
}

async function api(path, params = {}, signal) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === '' || v == null || v === false) continue;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, x)); else u.searchParams.set(k, v);
  }
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(u, { signal });
    if (r.ok) return r.json();
    if (attempt < 2 && (r.status === 429 || r.status >= 500)) { await new Promise(res => setTimeout(res, 800 * (attempt + 1))); continue; }
    throw new Error(`Error ${r.status}`);
  }
}

/* ---------- vídeos: reproducir solo los visibles ---------- */
const videoObs = new IntersectionObserver(entries => {
  for (const e of entries) {
    const v = e.target;
    if (e.isIntersecting) { if (!v.src) v.src = v.dataset.src; v.play().catch(() => {}); }
    else v.pause();
  }
}, { rootMargin: '200px' });

/* ---------- duración de vídeos ---------- */
// La API no da la duración; se lee de la cabecera del vídeo (pocos KB) y se guarda.
const durCache = new Map();
const fmtDur = d => isFinite(d) ? `${Math.floor(d / 60)}:${String(Math.round(d % 60)).padStart(2, '0')}` : '';
function probeDuration(it, signal) {
  if (durCache.has(it.id)) return Promise.resolve(durCache.get(it.id));
  return new Promise(res => {
    const v = document.createElement('video');
    let done = false;
    const end = d => {
      if (done) return; done = true;
      clearTimeout(t); signal?.removeEventListener('abort', stop);
      v.removeAttribute('src'); v.load();
      if (!isFinite(d) || d <= 0) d = +it.meta?.duration || NaN;
      if (isFinite(d)) durCache.set(it.id, d);
      res(d);
    };
    const stop = () => end(NaN);
    const t = setTimeout(stop, 8000);
    signal?.addEventListener('abort', stop);
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => end(v.duration);
    v.onerror = stop;
    v.src = media(it.url, thumbW(), 'video');
  });
}
async function probeAll(items, signal, conc = 8) {
  const q = items.filter(it => it.type === 'video' && !durCache.has(it.id));
  await Promise.all(Array.from({ length: Math.min(conc, q.length) }, async () => {
    while (q.length && !signal?.aborted) await probeDuration(q.shift(), signal);
  }));
}
const DUR_RANGES = { short: [0, 5.5], mid: [5.5, 10.5], long: [10.5, Infinity], vlong: [20.5, Infinity] };
const durActive = () => $('#imgType').value === 'video' && !!DUR_RANGES[$('#imgDur').value];

/* ---------- Feed genérico con scroll infinito ---------- */
class Feed {
  // target: seguir buscando sin esperar al scroll hasta tener al menos tantos resultados
  constructor(root, { load, render, filter = () => true, ratio, minPerLoad = 14, prep = null, target = 0 }) {
    Object.assign(this, { root, load, render, filter, ratio, minPerLoad, prep, target });
    this.status = h('div', { class: 'status' });
    this.sentinel = h('div', { style: { height: '1px' } });
    this.io = new IntersectionObserver(es => { if (es[0].isIntersecting) this.more(); }, { rootMargin: '1500px' });
    this.reset();
  }
  reset() {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    this.items = []; this.raw = []; this.ids = new Set(); this.cursor = null; this.done = false; this.loading = false;
    this.needsRefilter = false;
    this.startHunt();
    this.grid = null;
    this.layout();
    put(this.root, this.grid, this.status, this.sentinel);
    this.io.disconnect(); this.io.observe(this.sentinel);
    this.dirty = false;
    this.more();
  }
  layout() {
    const n = colCount();
    this.cols = Array.from({ length: n }, () => h('div', { class: 'col' }));
    this.heights = new Array(n).fill(0);
    const grid = h('div', { class: 'masonry' }, this.cols);
    if (this.grid) this.grid.replaceWith(grid);
    this.grid = grid;
  }
  relayout() {               // recolocar lo ya cargado con otro número de columnas
    this.layout();
    this.items.forEach((it, i) => this.append(it, i));
  }
  visible() { return this.root.offsetParent !== null; }
  startHunt() { this.scanStart = this.raw.length; this.budget = 10000; this.paused = false; }
  hunting() { return this.items.length < this.target; }
  // aplicar de nuevo los filtros locales a lo ya descargado, sin volver a pedirlo
  async refilter(toTop = true) {
    this.ctrl?.abort();
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    this.loading = false; this.needsRefilter = false;
    this.startHunt();
    if (this.prep && this.raw.length) {
      this.loading = true; this.status.textContent = 'Aplicando filtro…';
      await this.prep(this.raw, signal);
      if (signal.aborted) return;
      this.loading = false;
    }
    this.items = this.raw.filter(it => this.filter(it));
    this.layout();
    this.items.forEach((it, i) => this.append(it, i));
    this.status.textContent = this.done ? (this.items.length ? 'No hay más' : 'Sin resultados con estos filtros') : '';
    if (toTop && this.visible()) scrollTo(0, 0);
    this.more();             // completar si han quedado pocas
  }
  async more() {
    if (this.loading || this.done || this.paused || !this.visible()) return;
    this.loading = true;
    const signal = this.ctrl.signal;
    this.status.textContent = 'Cargando…';
    let added = 0, pages = 0;
    const scanned = () => this.raw.length - this.scanStart;
    const keepGoing = () => this.hunting() ? scanned() < this.budget : (added < this.minPerLoad && pages < 8);
    try {
      while (!this.done && keepGoing()) {
        const { items, next } = await this.load(this.cursor, signal);
        if (signal.aborted) return;
        if (this.prep) { await this.prep(items, signal); if (signal.aborted) return; }
        pages++;
        this.cursor = next;
        if (!next || !items.length) this.done = true;
        for (const it of items) {
          if (this.ids.has(it.id)) continue;
          this.ids.add(it.id);
          this.raw.push(it);
          if (!this.filter(it)) continue;
          this.items.push(it);
          this.append(it, this.items.length - 1);
          added++;
        }
        if (this.hunting() && !this.done)
          this.status.textContent = `Buscando… ${this.items.length} encontrados · ${scanned().toLocaleString('es')} revisados`;
      }
    } catch (e) {
      if (signal.aborted) return;
      put(this.status, 'No se pudo cargar (' + e.message + ')', h('br'),
        h('button', { class: 'btn', onclick: () => { this.loading = false; this.more(); } }, 'Reintentar'));
      this.loading = false;
      return;
    }
    this.loading = false;
    this.status.textContent = this.done ? (this.items.length ? 'No hay más' : 'Sin resultados con estos filtros') : '';
    if (!this.done && this.hunting()) {   // tope de seguridad: preguntar antes de seguir
      this.paused = true;
      put(this.status, `${this.items.length} encontrados tras revisar ${scanned().toLocaleString('es')}`, h('br'),
        h('button', { class: 'btn', onclick: () => { this.budget += 10000; this.paused = false; this.more(); } }, 'Buscar más'));
      return;
    }
    // si el centinela sigue a la vista, seguir cargando
    if (!this.done && this.sentinel.getBoundingClientRect().top < innerHeight + 1500) this.more();
  }
  append(it, idx) {
    const r = this.ratio ? this.ratio(it) : 1;
    let c = 0;
    for (let i = 1; i < this.cols.length; i++) if (this.heights[i] < this.heights[c]) c = i;
    this.heights[c] += r;
    this.cols[c].append(this.render(it, idx, this));
  }
}

/* ---------- tiles ---------- */
function reactions(s = {}) { return (s.likeCount || 0) + (s.heartCount || 0) + (s.laughCount || 0) + (s.cryCount || 0); }
const imgRatio = it => Math.min(Math.max((it.height || 1) / (it.width || 1), 0.5), 2);

function imageTile(it, idx, feed, list) {
  const r = imgRatio(it);
  const el = h('button', { class: 'tile', style: { aspectRatio: `1 / ${r}` }, 'aria-label': 'Abrir imagen' });
  if (it.type === 'video') {
    const v = h('video', { muted: true, loop: true, playsinline: true, preload: 'none', 'data-src': media(it.url, thumbW(), 'video') });
    v.muted = true;
    const badge = h('span', { class: 'badge' }, durCache.has(it.id) ? '▶ ' + fmtDur(durCache.get(it.id)) : '▶ Vídeo');
    v.addEventListener('loadedmetadata', () => {
      if (isFinite(v.duration) && v.duration > 0) { durCache.set(it.id, v.duration); badge.textContent = '▶ ' + fmtDur(v.duration); }
    });
    el.append(v, badge);
    videoObs.observe(v);
  } else {
    el.append(h('img', { src: media(it.url, thumbW()), loading: 'lazy', decoding: 'async', alt: '' }));
  }
  if (it.stats) el.append(h('span', { class: 'stats' }, h('span', {}, '♥ ' + fmt(reactions(it.stats))), h('span', {}, '💬 ' + fmt(it.stats.commentCount))));
  if (S.blur && isAdult(it)) el.classList.add('blurred');
  el.addEventListener('click', () => {
    if (el.classList.contains('blurred')) { el.classList.remove('blurred'); return; }
    Viewer.open(list || feed.items, idx, feed);
  });
  return el;
}

function coverOf(m) {
  for (const v of m.modelVersions || []) for (const im of v.images || []) if (allowed(im)) return im;
  return null;
}
function modelTile(m) {
  const cover = coverOf(m);
  const el = h('a', { class: 'tile mcard', href: `#/model/${m.id}` });
  const box = h('div', { class: 'cover' });
  if (cover) {
    if (cover.type === 'video') {
      const v = h('video', { muted: true, loop: true, playsinline: true, preload: 'none', 'data-src': media(cover.url, thumbW(), 'video') });
      v.muted = true; videoObs.observe(v); box.append(v);
    } else box.append(h('img', { src: media(cover.url, thumbW()), loading: 'lazy', decoding: 'async', alt: '' }));
    if (S.blur && isAdult(cover)) el.classList.add('blurred');
  } else box.append(h('div', { class: 'noimg' }, 'Sin portada'));
  const ver = m.modelVersions?.[0];
  el.append(box,
    h('span', { class: 'badge' }, typeName(m.type)),
    h('div', { class: 'info' },
      h('div', { class: 'name' }, m.name),
      h('div', { class: 'sub' },
        h('span', {}, '⬇ ' + fmt(m.stats?.downloadCount)),
        h('span', {}, '👍 ' + fmt(m.stats?.thumbsUpCount)),
        ver?.baseModel ? h('span', {}, ver.baseModel) : null)));
  el.addEventListener('click', e => { if (el.classList.contains('blurred')) { e.preventDefault(); el.classList.remove('blurred'); } });
  return el;
}
const typeName = t => ({ TextualInversion: 'Embedding', LORA: 'LoRA', Controlnet: 'ControlNet' }[t] || t);

/* ---------- filtros ---------- */
function imageFilter(it) {
  if (!allowed(it)) return false;
  if (it.baseModel) seenBaseModels.add(it.baseModel);
  const f = S.imgF, type = $('#imgType').value;
  if (type !== 'all' && it.type !== type) return false;
  if (durActive()) {
    const d = durCache.get(it.id), [lo, hi] = DUR_RANGES[$('#imgDur').value];
    if (!(d >= lo && d < hi)) return false;
  }
  if (f.baseModel && it.baseModel !== f.baseModel) return false;
  if (f.orient) {
    const r = (it.width || 1) / (it.height || 1);
    const o = r < 0.9 ? 'v' : r > 1.1 ? 'h' : 's';
    if (o !== f.orient) return false;
  }
  if (+f.minReact && reactions(it.stats) < +f.minReact) return false;
  const prompt = lc(it.meta?.prompt);
  if (f.onlyPrompt && !prompt) return false;
  const has = splitTerms(f.promptHas), not = splitTerms(f.promptNot);
  if (has.length && !has.every(t => prompt.includes(t))) return false;
  if (not.length && not.some(t => prompt.includes(t))) return false;
  if (f.hidden && lines(f.hidden).includes(lc(it.username))) return false;
  return true;
}
function modelFilter(m) {
  const f = S.modF;
  if (!modelAllowed(m)) return false;
  const mediaSel = $('#modMedia').value;
  if (mediaSel !== 'all' && (isVideoModel(m) ? 'video' : 'image') !== mediaSel) return false;
  if (+f.minDl && (m.stats?.downloadCount || 0) < +f.minDl) return false;
  if (f.noPaid) {
    const v = m.modelVersions?.[0] || {};
    if (m.hasActivePaidAccess || v.paidAccess || v.availability === 'EarlyAccess' || m.availability === 'EarlyAccess') return false;
  }
  if (f.commercial) {
    const c = m.allowCommercialUse;
    if (!c || c === 'None' || (Array.isArray(c) && !c.length)) return false;
  }
  if (f.hidden && lines(f.hidden).includes(lc(m.creator?.username))) return false;
  return true;
}
function isVideoModel(m) {
  return isVideoBase(m.modelVersions?.[0]?.baseModel) || coverOf(m)?.type === 'video';
}
const activeCount = f => Object.entries(f).filter(([, v]) => v && v !== '0').length;

/* ---------- feeds principales ---------- */
// selects: restaurar y guardar
for (const id of ['imgSort', 'imgPeriod', 'imgType', 'imgDur', 'modSort', 'modPeriod', 'modType', 'modMedia']) {
  const el = $('#' + id);
  if (S.sel[id]) el.value = S.sel[id];
  if (!el.value) el.selectedIndex = id === 'imgPeriod' ? 1 : 0;
  let prev = el.value;
  el.addEventListener('change', () => {
    S.sel[id] = el.value; store.set('sel', S.sel);
    const feed = id.startsWith('img') ? imagesFeed : modelsFeed;
    // «Solo vídeo» en modelos cambia lo que se pide a la API (salvo con modelo base fijado)
    const local = id === 'imgDur' || (id === 'modMedia' && (S.modF.baseModel || (prev !== 'video' && el.value !== 'video')));
    prev = el.value;
    local ? feed.refilter() : feed.reset();
  });
}
if (!S.sel.imgPeriod) $('#imgPeriod').value = 'Week';
const showDur = () => { $('#imgDur').hidden = $('#imgType').value !== 'video'; };
$('#imgType').addEventListener('change', showDur); showDur();
if (!S.sel.modPeriod) $('#modPeriod').value = 'Month';

const imgView = $('#view-images'), modView = $('#view-models'), detailView = $('#view-detail');

const imagesFeed = new Feed($('.feed', imgView), {
  ratio: imgRatio, filter: imageFilter, target: 200,
  prep: (items, signal) => durActive() ? probeAll(items, signal) : null,
  render: (it, idx, feed) => imageTile(it, idx, feed),
  load: async (cursor, signal) => {
    const d = await api('/images', {
      limit: 50, browsingLevel: S.mask, sort: $('#imgSort').value, period: $('#imgPeriod').value,
      type: $('#imgType').value === 'all' ? '' : $('#imgType').value,
      withMeta: true, cursor,
    }, signal);
    return { items: d.items || [], next: d.metadata?.nextCursor };
  },
});

const modelsFeed = new Feed($('.feed', modView), {
  ratio: () => 4 / 3, filter: modelFilter, minPerLoad: 12, target: 200,
  render: m => modelTile(m),
  load: async (cursor, signal) => {
    const q = $('#searchInput').value.trim();
    const d = await api('/models', {
      limit: 30, sort: $('#modSort').value, period: q ? '' : $('#modPeriod').value,
      types: $('#modType').value,
      baseModels: S.modF.baseModel || ($('#modMedia').value === 'video' ? VIDEO_BASES : ''), nsfw: S.mask !== 1,
      query: q, cursor,
    }, signal);
    return { items: d.items || [], next: d.metadata?.nextCursor };
  },
});

$('#searchForm').addEventListener('submit', e => {
  e.preventDefault();
  const q = $('#searchInput').value.trim();
  $('#searchInput').blur();
  if (q.startsWith('@') && q.length > 1) { location.hash = '#/user/' + encodeURIComponent(q.slice(1)); return; }
  modelsFeed.reset();
});
$('#searchInput').addEventListener('search', () => { if (!$('#searchInput').value) modelsFeed.reset(); });

/* ---------- diálogos de filtros ---------- */
function setupFilterDialog(dlg, key, feed, btn) {
  const form = $('form', dlg);
  const fill = () => {
    if (key === 'imgF') {
      const sel = form.elements.baseModel;
      const cur = S.imgF.baseModel || '';
      const opts = [...new Set([...seenBaseModels, cur].filter(Boolean))].sort();
      put(sel, h('option', { value: '' }, 'Cualquiera'), ...opts.map(o => h('option', {}, o)));
      sel.value = cur;
    }
    for (const el of form.elements) {
      if (!el.name) continue;
      const v = S[key][el.name];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? (el.tagName === 'SELECT' ? el.options[0].value : '');
    }
  };
  const mark = () => { const n = activeCount(S[key]); btn.textContent = n ? `Más filtros (${n})` : 'Más filtros'; btn.classList.toggle('on', !!n); };
  btn.addEventListener('click', () => { fill(); dlg.showModal(); });
  const apply = f => {
    const server = key === 'modF' && (f.baseModel || '') !== (S.modF.baseModel || '');
    S[key] = f; store.set(key, f); mark();
    server ? feed.reset() : feed.refilter();
  };
  $('[data-reset]', form).addEventListener('click', () => { dlg.close('reset'); apply({}); });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'ok') return;
    const f = {};
    for (const el of form.elements) if (el.name) f[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
    apply(f);
  });
  mark();
}
setupFilterDialog($('#imgFiltersDlg'), 'imgF', imagesFeed, $('[data-more=images]'));
setupFilterDialog($('#modFiltersDlg'), 'modF', modelsFeed, $('[data-more=models]'));

/* ---------- nivel de contenido ---------- */
const levelBtn = $('#levelBtn'), levelDlg = $('#levelDlg');
function showLevel() {
  levelBtn.textContent = S.mask === ALL ? 'Todo' : LEVELS.filter(([b]) => S.mask & b).map(([, n]) => n).join(' + ');
  levelBtn.dataset.l = (S.mask & ADULT) ? 'X' : 'None';
}
showLevel();
levelBtn.addEventListener('click', () => {
  for (const r of levelDlg.querySelectorAll('[name=lvl]')) r.checked = (S.mask & +r.value) !== 0;
  $('#blurChk').checked = S.blur;
  levelDlg.showModal();
});
levelDlg.addEventListener('close', () => {
  let mask = 0;
  for (const r of levelDlg.querySelectorAll('[name=lvl]:checked')) mask |= +r.value;
  if (!mask) { mask = S.mask; toast('Marca al menos un nivel'); }
  const blur = $('#blurChk').checked;
  if (mask === S.mask && blur === S.blur) return;
  S.mask = mask; S.blur = blur; store.set('mask', mask); store.set('blur', blur); showLevel();
  imagesFeed.dirty = modelsFeed.dirty = true;
  route(true);
});

/* ---------- descripción HTML segura ---------- */
const OK_TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'A', 'IMG', 'H1', 'H2', 'H3', 'H4', 'H5', 'BLOCKQUOTE', 'CODE', 'PRE', 'HR', 'SPAN', 'DIV', 'TABLE', 'TR', 'TD', 'TH', 'TBODY', 'THEAD']);
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const walk = node => {
    for (const el of [...node.children]) {
      if (!OK_TAGS.has(el.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'TEXTAREA', 'BUTTON', 'SVG', 'MATH'].includes(el.tagName)) { el.remove(); continue; }
        walk(el); el.replaceWith(...el.childNodes); continue;
      }
      const href = el.getAttribute('href'), src = el.getAttribute('src');
      for (const a of [...el.attributes]) el.removeAttribute(a.name);
      if (el.tagName === 'A' && href && /^https?:/i.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
      if (el.tagName === 'IMG') { if (src && /^https:/i.test(src)) { el.setAttribute('src', src); el.setAttribute('loading', 'lazy'); } else { el.remove(); continue; } }
      walk(el);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

/* ---------- selector imágenes / vídeos ---------- */
function mediaSelect(value, onChange) {
  const sel = h('select', { 'aria-label': 'Tipo' },
    h('option', { value: 'all' }, 'Todo'),
    h('option', { value: 'image' }, 'Solo imágenes'),
    h('option', { value: 'video' }, 'Solo vídeos'));
  sel.value = value;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
let detailMedia = 'all';

/* ---------- vista: modelo ---------- */
let detailFeed = null;
async function renderModel(id) {
  setTitle('Modelo', true);
  put(detailView, h('div', { class: 'status' }, 'Cargando…'));
  let m;
  try { m = await api('/models/' + id); } catch (e) {
    put(detailView, h('div', { class: 'status' }, 'No se pudo cargar el modelo (' + e.message + ')'));
    return;
  }
  if (currentRoute !== '#/model/' + id) return;
  setTitle(m.name, true);
  const versions = m.modelVersions || [];
  let ver = versions[0];
  const head = h('div', { class: 'detail-head' },
    h('h2', {}, m.name),
    h('div', { class: 'meta-row' },
      m.creator?.username ? h('a', { class: 'pill link', href: '#/user/' + encodeURIComponent(m.creator.username) }, '@' + m.creator.username) : null,
      h('span', { class: 'pill' }, typeName(m.type)),
      h('span', { class: 'pill' }, '⬇ ' + fmt(m.stats?.downloadCount)),
      h('span', { class: 'pill' }, '👍 ' + fmt(m.stats?.thumbsUpCount)),
      h('span', { class: 'pill' }, '💬 ' + fmt(m.stats?.commentCount))),
    m.tags?.length ? h('div', { class: 'meta-row' }, m.tags.slice(0, 12).map(t => h('span', { class: 'pill' }, '#' + t))) : null);

  const verBar = h('div', { class: 'versions' });
  const verBox = h('div');
  const showVersion = v => {
    ver = v;
    for (const b of verBar.children) b.classList.toggle('on', b.dataset.id == v.id);
    const file = v.files?.find(f => f.primary) || v.files?.[0];
    const showcase = (v.images || []).filter(im => allowed(im) && (detailMedia === 'all' || (im.type || 'image') === detailMedia));
    const strip = h('div', { class: 'masonry' });
    put(verBox, 
      h('div', { class: 'meta-row', style: { padding: '0 14px' } },
        h('span', { class: 'pill' }, v.baseModel),
        v.publishedAt ? h('span', { class: 'pill' }, new Date(v.publishedAt).toLocaleDateString('es')) : null,
        file?.sizeKB ? h('span', { class: 'pill' }, (file.sizeKB / 1024 > 1024 ? (file.sizeKB / 1048576).toFixed(2) + ' GB' : (file.sizeKB / 1024).toFixed(0) + ' MB')) : null),
      v.trainedWords?.length ? h('div', { class: 'trained' }, h('div', { class: 'section-title', style: { padding: '6px 0' } }, 'Palabras clave (toca para copiar)'),
        v.trainedWords.map(w => h('code', { onclick: () => copy(w) }, w))) : null,
      h('div', { class: 'actions' },
        v.downloadUrl ? h('a', { class: 'btn primary', href: v.downloadUrl, target: '_blank', rel: 'noopener' }, '⬇ Descargar') : null,
        h('a', { class: 'btn', href: `${siteBase()}/models/${m.id}?modelVersionId=${v.id}`, target: '_blank', rel: 'noopener' }, 'Ver en Civitai ↗')),
      h('div', { class: 'filters' }, mediaSelect(detailMedia, val => { detailMedia = val; showVersion(v); })),
      showcase.length ? h('div', { class: 'section-title' }, 'Galería del creador') : null,
      strip,
      h('div', { class: 'section-title' }, 'Imágenes de la comunidad'),
      h('div', { class: 'feed' }));
    // galería del creador en columnas
    const n = colCount();
    const cols = Array.from({ length: n }, () => h('div', { class: 'col' })), hs = new Array(n).fill(0);
    showcase.forEach((im, i) => {
      let c = 0; for (let k = 1; k < n; k++) if (hs[k] < hs[c]) c = k;
      hs[c] += imgRatio(im); cols[c].append(imageTile(im, i, null, showcase));
    });
    strip.append(...cols);
    detailFeed?.ctrl?.abort();
    detailFeed = new Feed($('.feed', verBox), {
      ratio: imgRatio, filter: allowed,
      render: (it, idx, feed) => imageTile(it, idx, feed),
      load: async (cursor, signal) => {
        const d = await api('/images', { limit: 40, modelVersionId: v.id, browsingLevel: S.mask, type: detailMedia === 'all' ? '' : detailMedia, sort: 'Most Reactions', period: 'AllTime', withMeta: true, cursor }, signal);
        return { items: d.items || [], next: d.metadata?.nextCursor };
      },
    });
  };
  for (const v of versions) verBar.append(h('button', { 'data-id': v.id, onclick: () => showVersion(v) }, v.name));

  const desc = m.description ? h('details', { class: 'desc' }, h('summary', {}, 'Descripción'), h('div', { class: 'body', html: sanitize(m.description) })) : null;
  put(detailView, head, versions.length > 1 ? verBar : null, desc, verBox);
  if (ver) showVersion(ver);
}

/* ---------- vista: usuario ---------- */
async function renderUser(name, tab) {
  setTitle('@' + name, true);
  const base = '#/user/' + encodeURIComponent(name);
  const sortSel = h('select', { 'aria-label': 'Orden' },
    h('option', { value: 'Newest' }, 'Más nuevas'),
    h('option', { value: 'Most Reactions' }, 'Más reacciones'));
  const feedBox = h('div', { class: 'feed' });
  put(detailView, 
    h('div', { class: 'subtabs versions', style: { padding: '10px 12px 0' } },
      h('button', { class: tab === 'models' ? '' : 'on', onclick: () => location.replace(base) }, 'Imágenes'),
      h('button', { class: tab === 'models' ? 'on' : '', onclick: () => location.replace(base + '/models') }, 'Modelos'),
      h('a', { class: 'btn', style: { marginLeft: 'auto', padding: '6px 12px' }, href: `${siteBase()}/user/${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener' }, 'Civitai ↗')),
    tab === 'models' ? null : h('div', { class: 'filters' }, sortSel, mediaSelect(detailMedia, val => { detailMedia = val; mk(); })),
    feedBox);
  detailFeed?.ctrl?.abort();
  let mk = () => {};
  if (tab === 'models') {
    detailFeed = new Feed(feedBox, {
      ratio: () => 4 / 3, filter: modelAllowed, minPerLoad: 12,
      render: m => modelTile(m),
      load: async (cursor, signal) => {
        const d = await api('/models', { limit: 30, username: name, sort: 'Newest', nsfw: S.mask !== 1, cursor }, signal);
        return { items: d.items || [], next: d.metadata?.nextCursor };
      },
    });
  } else {
    mk = () => {
      detailFeed?.ctrl?.abort();
      detailFeed = new Feed(feedBox, {
        ratio: imgRatio, filter: allowed,
        render: (it, idx, feed) => imageTile(it, idx, feed),
        load: async (cursor, signal) => {
          const d = await api('/images', { limit: 50, username: name, browsingLevel: S.mask, type: detailMedia === 'all' ? '' : detailMedia, sort: sortSel.value, period: 'AllTime', withMeta: true, cursor }, signal);
          return { items: d.items || [], next: d.metadata?.nextCursor };
        },
      });
    };
    sortSel.addEventListener('change', mk);
    mk();
  }
}

/* ---------- visor ---------- */
const versionCache = new Map();
const Viewer = {
  el: $('#viewer'), track: $('#viewer .v-track'), sheet: $('#viewer .v-sheet'), count: $('#viewer .v-count'),
  bar: $('#viewer .v-bar'), list: [], idx: 0, feed: null, after: null, sound: false,
  cur() { return this.track.children[1]?.querySelector('video') || null; },
  open(list, idx, feed) {
    this.list = list; this.idx = idx; this.feed = feed;
    this.el.hidden = false; this.el.classList.remove('chrome-off'); this.sheet.hidden = true;
    document.body.classList.add('no-scroll');
    history.pushState({ viewer: 1 }, '', location.href);
    this.build();
    this.tick();
  },
  close() { if (!this.el.hidden) history.back(); },
  hide() {
    this.el.hidden = true; document.body.classList.remove('no-scroll');
    put(this.track, ); this.sheet.hidden = true; this.bar.hidden = true;
    cancelAnimationFrame(this.raf);
    if (imagesFeed.needsRefilter && imagesFeed.visible()) imagesFeed.refilter(false);
  },
  go(hash) { this.after = hash; history.back(); },
  slide(i) {
    const it = this.list[i];
    const s = h('div', { class: 'v-slide' });
    if (!it) return s;
    if (it.type === 'video') s.append(h('video', { src: media(it.url, 1080, 'video'), autoplay: i === this.idx, muted: true, loop: true, playsinline: true }));
    else s.append(h('img', { src: media(it.url, 1600), alt: '', draggable: 'false' }));
    return s;
  },
  build() {
    this.track.style.transition = 'none';
    this.track.style.transform = 'translateX(-100vw)';
    put(this.track, this.slide(this.idx - 1), this.slide(this.idx), this.slide(this.idx + 1));
    const cur = this.cur();
    this.bar.hidden = !cur;
    if (cur) {
      cur.muted = !this.sound;
      cur.onplay = cur.onpause = () => $('.v-play').classList.toggle('paused', cur.paused);
      cur.ontimeupdate = cur.onseeked = cur.onloadedmetadata = () => this.tick();
      cur.play().catch(() => { cur.muted = true; this.sound = false; this.syncMute(); cur.play().catch(() => {}); });
      this.syncMute();
    }
    this.count.textContent = `${this.idx + 1} / ${this.list.length}${this.feed && !this.feed.done ? '+' : ''}`;
    if (!this.sheet.hidden) this.info();
    if (this.feed && this.idx > this.list.length - 6) this.feed.more();
  },
  syncMute() { const b = $('.v-mute'); b.classList.toggle('on', this.sound); b.setAttribute('aria-label', this.sound ? 'Silenciar' : 'Activar sonido'); },
  tick() {                       // línea de tiempo: actualizar mientras el visor está abierto
    cancelAnimationFrame(this.raf);
    const v = this.cur();
    if (v && !this.bar.hidden) {
      const d = v.duration, t = v.currentTime, f = isFinite(d) && d > 0 ? Math.min(1, t / d) : 0;
      $('.v-seek-fill').style.width = f * 100 + '%';
      $('.v-seek-knob').style.left = f * 100 + '%';
      $('.v-time').textContent = fmtDur(t) || '0:00';
      $('.v-dur').textContent = fmtDur(d) || '–:––';
      $('.v-play').classList.toggle('paused', v.paused);
    }
    if (!this.el.hidden) this.raf = requestAnimationFrame(() => this.tick());
  },
  step(d) {
    const n = this.idx + d;
    if (n < 0 || n >= this.list.length) { this.snap(0); return; }
    this.track.style.transition = 'transform .22s ease-out';
    this.track.style.transform = `translateX(${-100 - d * 100}vw)`;
    setTimeout(() => { this.idx = n; this.build(); }, 220);
  },
  snap(dx) {
    this.track.style.transition = 'transform .2s ease-out';
    this.track.style.transform = `translateX(calc(-100vw + ${dx}px))`;
  },
  async info() {
    const it = this.list[this.idx];
    if (!it) return;
    const sheet = this.sheet;
    sheet.hidden = false;
    const myIdx = this.idx;
    if (it.meta === undefined || (it.meta == null && it.hasMeta)) {
      put(sheet, h('div', { class: 'status' }, 'Cargando información…'));
      try { const d = await api('/images', { imageId: it.id, browsingLevel: ALL, withMeta: true }); const full = d.items?.[0] || {}; Object.assign(it, { ...full, meta: full.meta ?? null }); }
      catch { it.meta = null; }
      if (myIdx !== this.idx || sheet.hidden) return;
    }
    const meta = it.meta || {};
    const kv = [['Modelo', meta.Model], ['Base', it.baseModel], ['Sampler', meta.sampler], ['Pasos', meta.steps], ['CFG', meta.cfgScale], ['Seed', meta.seed], ['Tamaño', it.width && `${it.width}×${it.height}`], ['Fecha', it.createdAt && new Date(it.createdAt).toLocaleString('es')]].filter(([, v]) => v != null && v !== '');
    const resBox = h('div', { class: 'meta-row' });
    put(sheet, ...[
      h('div', { class: 'row' },
        it.username ? h('a', { href: '#', onclick: e => { e.preventDefault(); this.go('#/user/' + encodeURIComponent(it.username)); } }, '@' + it.username) : h('span'),
        it.stats ? h('span', { style: { color: 'var(--muted)', fontSize: '13px' } }, `♥ ${fmt(reactions(it.stats))} · 💬 ${fmt(it.stats.commentCount)}`) : null),
      h('div', { class: 'actions', style: { padding: 0 } },
        h('a', { class: 'btn', href: `${siteBase()}/images/${it.id}`, target: '_blank', rel: 'noopener' }, 'Ver en Civitai ↗'),
        h('a', { class: 'btn', href: it.url, target: '_blank', rel: 'noopener' }, 'Original'),
        it.username ? h('button', { class: 'btn', onclick: () => {
          const cur = lines(S.imgF.hidden);
          if (!cur.includes(lc(it.username))) { S.imgF.hidden = [...cur, lc(it.username)].join('\n'); store.set('imgF', S.imgF); }
          toast('@' + it.username + ' oculto'); imagesFeed.needsRefilter = true;
          $('[data-more=images]').textContent = `Más filtros (${activeCount(S.imgF)})`; $('[data-more=images]').classList.add('on');
        } }, 'Ocultar usuario') : null),
      meta.prompt ? [h('h4', {}, 'Prompt', h('button', { onclick: () => copy(meta.prompt) }, 'Copiar')), h('div', { class: 'prompt' }, meta.prompt)] : h('p', { style: { color: 'var(--muted)' } }, 'Sin prompt público.'),
      meta.negativePrompt ? [h('h4', {}, 'Negativo', h('button', { onclick: () => copy(meta.negativePrompt) }, 'Copiar')), h('div', { class: 'prompt' }, meta.negativePrompt)] : null,
      kv.length ? h('dl', { class: 'kv' }, kv.map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))])) : null,
      h('h4', {}, 'Recursos usados'), resBox].flat(Infinity).filter(Boolean));
    // recursos: versiones de modelo → enlaces
    const vids = [...new Set([...(it.modelVersionIds || []), ...((meta.civitaiResources || []).map(r => r.modelVersionId))].filter(Boolean))].slice(0, 10);
    if (!vids.length) {
      const names = (meta.resources || []).map(r => r.name).filter(Boolean);
      resBox.append(names.length ? names.map(n => h('span', { class: 'pill' }, n)) : h('span', { class: 'pill' }, 'Sin datos'));
      return;
    }
    for (const vid of vids) {
      const pill = h('span', { class: 'pill' }, '…');
      resBox.append(pill);
      (versionCache.get(vid) || versionCache.set(vid, api('/model-versions/' + vid).catch(() => null)).get(vid)).then(v => {
        if (!v) { pill.remove(); return; }
        const a = h('a', { class: 'pill link', href: '#', onclick: e => { e.preventDefault(); this.go('#/model/' + v.modelId); } }, `${v.model?.name || 'Modelo'} · ${typeName(v.model?.type || '')}`);
        pill.replaceWith(a);
      });
    }
  },
};
$('.v-close').addEventListener('click', () => Viewer.close());
$('.v-play').addEventListener('click', () => { const v = Viewer.cur(); if (v) v.paused ? v.play().catch(() => {}) : v.pause(); });
$('.v-mute').addEventListener('click', () => {
  Viewer.sound = !Viewer.sound; Viewer.syncMute();
  const v = Viewer.cur(); if (v) { v.muted = !Viewer.sound; if (v.paused) v.play().catch(() => {}); }
});
(() => {                         // arrastrar en la línea de tiempo
  const seek = $('.v-seek');
  let wasPlaying = false;
  const to = e => {
    const v = Viewer.cur(); if (!v || !isFinite(v.duration)) return;
    const r = seek.getBoundingClientRect();
    v.currentTime = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 0.999) * v.duration;
    Viewer.tick();
  };
  seek.addEventListener('pointerdown', e => {
    const v = Viewer.cur(); if (!v) return;
    seek.setPointerCapture(e.pointerId); seek.classList.add('drag');
    wasPlaying = !v.paused; v.pause(); to(e);
  });
  seek.addEventListener('pointermove', e => { if (seek.classList.contains('drag')) to(e); });
  const up = () => {
    if (!seek.classList.contains('drag')) return;
    seek.classList.remove('drag');
    if (wasPlaying) Viewer.cur()?.play().catch(() => {});
  };
  seek.addEventListener('pointerup', up); seek.addEventListener('pointercancel', up);
})();
$('.v-info-btn').addEventListener('click', () => { if (Viewer.sheet.hidden) Viewer.info(); else Viewer.sheet.hidden = true; });

// gestos en el visor
(() => {
  let x0 = 0, y0 = 0, dx = 0, dy = 0, t0 = 0, active = false, axis = null;
  const el = Viewer.el;
  el.addEventListener('pointerdown', e => {
    if (e.target.closest('.v-sheet, .v-top, .v-bar')) return;
    active = true; axis = null; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; t0 = Date.now();
  });
  el.addEventListener('pointermove', e => {
    if (!active) return;
    dx = e.clientX - x0; dy = e.clientY - y0;
    if (!axis && Math.hypot(dx, dy) > 10) axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    if (axis === 'x') { Viewer.track.style.transition = 'none'; Viewer.track.style.transform = `translateX(calc(-100vw + ${dx}px))`; }
    if (axis === 'y' && dy > 0) { Viewer.track.style.transition = 'none'; Viewer.track.style.transform = `translate(-100vw, ${dy}px)`; Viewer.el.style.background = `rgba(0,0,0,${Math.max(0.3, 1 - dy / 400)})`; }
  });
  const end = () => {
    if (!active) return;
    active = false;
    Viewer.el.style.background = '';
    const fast = Date.now() - t0 < 250;
    if (axis === 'x') {
      if (dx < -60 || (fast && dx < -25)) Viewer.step(1);
      else if (dx > 60 || (fast && dx > 25)) Viewer.step(-1);
      else Viewer.snap(0);
    } else if (axis === 'y') {
      if (dy > 110) Viewer.close();
      else if (dy < -60) Viewer.info();
      else { Viewer.track.style.transition = 'transform .2s'; Viewer.track.style.transform = 'translateX(-100vw)'; }
    } else if (!axis) {
      if (!Viewer.sheet.hidden) Viewer.sheet.hidden = true;
      else Viewer.el.classList.toggle('chrome-off');
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  addEventListener('keydown', e => {
    if (Viewer.el.hidden) return;
    if (e.key === 'ArrowRight') Viewer.step(1);
    else if (e.key === 'ArrowLeft') Viewer.step(-1);
    else if (e.key === 'Escape') Viewer.close();
    else if (e.key === 'i') $('.v-info-btn').click();
  });
})();

addEventListener('popstate', () => {
  if (!Viewer.el.hidden) {
    Viewer.hide();
    if (Viewer.after) { const a = Viewer.after; Viewer.after = null; setTimeout(() => { location.hash = a; }, 0); }
  }
});

/* ---------- router ---------- */
let currentRoute = '';
const scrollPos = {};
function setTitle(t, back) { $('#title').textContent = t; $('#backBtn').hidden = !back; }
$('#backBtn').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/images'; });

function route(force) {
  const hash = location.hash || '#/images';
  if (hash === currentRoute && !force) return;
  if (currentRoute) scrollPos[currentRoute] = scrollY;
  const prev = currentRoute;
  currentRoute = hash;
  const [, section, arg, sub] = hash.split('/');
  imgView.hidden = section !== 'images';
  modView.hidden = section !== 'models';
  detailView.hidden = !['model', 'user'].includes(section);
  for (const a of document.querySelectorAll('#tabbar a')) a.classList.toggle('active', a.dataset.tab === section || (section === 'model' && a.dataset.tab === 'models'));
  const restore = () => requestAnimationFrame(() => scrollTo(0, scrollPos[hash] || 0));
  if (section === 'models') {
    setTitle('Modelos', false);
    if (modelsFeed.dirty) modelsFeed.reset(); else if (!modelsFeed.items.length) modelsFeed.more();
    restore();
  } else if (section === 'model') {
    if (force || prev !== hash) renderModel(decodeURIComponent(arg)); scrollTo(0, 0);
  } else if (section === 'user') {
    renderUser(decodeURIComponent(arg), sub); scrollTo(0, 0);
  } else {
    if (section !== 'images') { location.replace('#/images'); return; }
    setTitle('Imágenes', false);
    if (imagesFeed.dirty) imagesFeed.reset();
    else if (imagesFeed.needsRefilter) imagesFeed.refilter(false);
    else if (!imagesFeed.items.length) imagesFeed.more();
    restore();
  }
}
addEventListener('hashchange', () => route());
route();

// botón 1 / 2 columnas y cambios de ancho (girar el móvil)
const colsBtn = $('#colsBtn');
const showCols = () => { colsBtn.dataset.c = S.cols; colsBtn.setAttribute('aria-label', S.cols === 1 ? 'Ver en 2 columnas' : 'Ver en 1 columna'); };
let lastCols = colCount();
function relayoutAll() {
  lastCols = colCount();
  const frac = scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight);
  imagesFeed.relayout(); modelsFeed.relayout();
  if (!detailView.hidden) route(true);
  else requestAnimationFrame(() => scrollTo(0, frac * (document.documentElement.scrollHeight - innerHeight)));
}
colsBtn.addEventListener('click', () => {
  S.cols = S.cols === 1 ? 2 : 1; store.set('cols', S.cols); showCols();
  relayoutAll();
});
showCols();
addEventListener('resize', () => { if (colCount() !== lastCols) relayoutAll(); });

if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
