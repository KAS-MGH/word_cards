(function () {
  'use strict';

  var KEY = 'wordcards.v1';
  var SETTINGS_KEY = 'wordcards.settings.v1';
  // data = { cards: [{id, word, translation, example?, box, due}], step: число }
  var data = load();
  var settings = loadSettings();   // { reverse: bool, activeTag: строка|null, lastLang: строка }
  var LANGS = [
    ['', 'Язык слова: не выбран', ''],
    ['en', 'English', 'en-US'],
    ['kk', 'Қазақша', 'kk-KZ'],
    ['ru', 'Русский', 'ru-RU'],
    ['de', 'Deutsch', 'de-DE'],
    ['fr', 'Français', 'fr-FR'],
    ['es', 'Español', 'es-ES'],
    ['tr', 'Türkçe', 'tr-TR']
  ];
  var POS = [
    ['', 'Часть речи: не выбрана'],
    ['noun', 'существительное'],
    ['verb', 'глагол'],
    ['adj', 'прилагательное'],
    ['adv', 'наречие'],
    ['pron', 'местоимение'],
    ['prep', 'предлог'],
    ['conj', 'союз'],
    ['interj', 'междометие'],
    ['phrase', 'фраза']
  ];
  var ttsTimer = null;
  var liveUtterances = [];
  var speakToken = 0;
  var current = null;   // id карточки в тренировке
  var flipped = false;
  var editingId = null;
  var confirmId = null; // карточка, ожидающая подтверждения удаления
  var query = '';

  function $(id) { return document.getElementById(id); }

  // день в формате ГГГГ-ММ-ДД, местное время
  function today() {
    var n = new Date();
    var m = n.getMonth() + 1, d = n.getDate();
    return n.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
  }

  // дополняет старые карточки новыми полями (спецификация 004), ничего не удаляя
  function normalizeCard(c) {
    var b = Number(c.box);
    c.box = isFinite(b) ? Math.max(0, Math.min(5, Math.floor(b))) : 0;
    if (typeof c.nextReview !== 'string' || !c.nextReview) c.nextReview = today();
    if (!Array.isArray(c.history)) c.history = [];
    c.known = Number(c.known) || 0;
    c.unknown = Number(c.unknown) || 0;
  }

  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.cards)) {
        d.cards.forEach(normalizeCard);
        return { cards: d.cards, step: d.step || 0 };
      }
    } catch (e) { /* пусто или повреждено */ }
    return { cards: [], step: 0 };
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (s && typeof s === 'object') {
        return {
          reverse: s.reverse === true,
          activeTag: typeof s.activeTag === 'string' ? s.activeTag : null,
          lastLang: typeof s.lastLang === 'string' ? s.lastLang : ''
        };
      }
    } catch (e) { /* ignore */ }
    return { reverse: false, activeTag: null, lastLang: '' };
  }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  function findCard(id) {
    for (var i = 0; i < data.cards.length; i++) {
      if (data.cards[i].id === id) return data.cards[i];
    }
    return null;
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isDuplicate(word, exceptId) {
    var n = norm(word);
    return data.cards.some(function (c) {
      return c.id !== exceptId && norm(c.word) === n;
    });
  }

  function labelOf(list, code) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === code) return list[i][1];
    return '';
  }

  function makeSelect(sel, list, value) {
    sel.textContent = '';
    list.forEach(function (o) {
      var op = document.createElement('option');
      op.value = o[0];
      op.textContent = o[1];
      sel.appendChild(op);
    });
    sel.value = value || '';
  }

  // "Еда, еда , ЕДА" -> ["еда"]; до 5 тегов по 20 символов
  function parseTags(str) {
    var out = [];
    String(str || '').split(',').forEach(function (t) {
      t = norm(t).slice(0, 20).trim();
      if (t && out.indexOf(t) < 0 && out.length < 5) out.push(t);
    });
    return out;
  }

  function tagsOf(c) { return Array.isArray(c.tags) ? c.tags : []; }

  function allTags() {
    var out = [];
    data.cards.forEach(function (c) {
      tagsOf(c).forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
    });
    return out.sort();
  }

  // Если выбранного тега больше нет — сбросить на «Все»
  function ensureTag() {
    if (settings.activeTag !== null && allTags().indexOf(settings.activeTag) < 0) {
      settings.activeTag = null;
      saveSettings();
    }
  }

  function inScope(c) {
    return settings.activeTag === null || tagsOf(c).indexOf(settings.activeTag) >= 0;
  }

  function renderTagBars() {
    ensureTag();
    var tags = allTags();
    ['tag-bar-train', 'tag-bar-deck'].forEach(function (id) {
      var bar = $(id);
      bar.textContent = '';
      bar.hidden = tags.length === 0;
      if (!tags.length) return;
      [null].concat(tags).forEach(function (t) {
        var b = button(t === null ? 'Все' : t, 'btn btn-light' + (settings.activeTag === t ? ' active' : ''), function () {
          settings.activeTag = t;
          saveSettings();
          current = null;
          flipped = false;
          if (!$('view-train').hidden) renderTrain(); else renderList();
        });
        b.setAttribute('aria-pressed', settings.activeTag === t ? 'true' : 'false');
        bar.appendChild(b);
      });
    });
  }

  // ---------- озвучка ----------
  function ttsMessage(text, host) {
    var m = $('tts-msg');
    // показываем сообщение над словом: первым элементом в карточке, где нажали «Слушать»
    if (host) host.insertBefore(m, host.firstChild);
    m.textContent = text;
    m.hidden = false;
    clearTimeout(ttsTimer);
    ttsTimer = setTimeout(function () { m.hidden = true; }, 3000);
  }

  function speak(card, host) {
    var NO = 'Нет голоса для этого языка или слова';
    var say = function () { ttsMessage(NO, host); };
    var synth = window.speechSynthesis;
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') { say(); return; }
    try {
      var code = card.lang || '';
      var tag = '';
      LANGS.forEach(function (l) { if (l[0] === code) tag = l[2]; });
      var voices = synth.getVoices ? synth.getVoices() : [];
      var voice = null;
      if (code) {
        voices.forEach(function (v) {
          if (!voice && String(v.lang).toLowerCase().indexOf(code) === 0) voice = v;
        });
        if (voices.length && !voice) { say(); return; }
      }
      var token = ++speakToken;
      var started = false;
      var attempt = function (n) {
        var u = new window.SpeechSynthesisUtterance(card.word);
        if (tag) u.lang = tag;
        if (voice) u.voice = voice;
        u.onstart = function () { started = true; };
        var release = function () {
          var k = liveUtterances.indexOf(u);
          if (k >= 0) liveUtterances.splice(k, 1);
        };
        u.onend = release;
        u.onerror = function (ev) {
          release();
          var er = ev && ev.error;
          if (er === 'language-unavailable' || er === 'voice-unavailable') say();
        };
        // ссылки держим до конца речи, иначе браузер может «потерять» объект и больше не говорить
        liveUtterances.push(u);
        var busy = synth.speaking || synth.pending;
        if (busy || n > 0) synth.cancel();
        // после cancel() Chrome нужна пауза, иначе следующая речь молча пропадает
        var delay = (busy || n > 0) ? 150 : 0;
        setTimeout(function () {
          if (token !== speakToken) return;
          try {
            synth.resume();
            synth.speak(u);
          } catch (e2) { say(); }
        }, delay);
        // речь не началась — пробуем заново (до 2 повторов), потом сообщаем
        setTimeout(function () {
          if (token !== speakToken || started) return;
          if (n < 2) attempt(n + 1); else say();
        }, delay + 1000);
      };
      attempt(0);
    } catch (e) { say(); }
  }

  // ---------- подсказки транскрипции ----------
  var ACCENTS = [['us', 'US'], ['uk', 'UK'], ['au', 'AU']];

  function accentLabel(code) { return labelOf(ACCENTS, code || ''); }

  // Кнопки с вариантами из dict.js; onPick(транскрипция, акцент)
  function fillSuggest(box, word, lang, onPick) {
    box.textContent = '';
    var e = lang === 'en' && window.WC_DICT ? window.WC_DICT[norm(word)] : null;
    if (!e || !Array.isArray(e)) { box.hidden = true; return; }
    var vars = [e[0], e[1], e[2] || e[1]];
    var same = vars[0] === vars[1] && vars[1] === vars[2];
    var n = same ? 1 : 3;
    for (var i = 0; i < n; i++) {
      (function (i) {
        var acc = same ? '' : ACCENTS[i][0];
        var label = same ? vars[0] : ACCENTS[i][1] + ' ' + vars[i];
        box.appendChild(button(label, 'btn btn-light', function () { onPick(vars[i], acc); }));
      })(i);
    }
    box.hidden = false;
  }

  var addAccent = '';
  function refreshAddHelpers() {
    fillSuggest($('in-sugg'), $('in-word').value, $('in-lang').value, function (tr, acc) {
      $('in-tr').value = tr;
      addAccent = acc;
    });
  }

  // Пример с выделением слова жирным (без innerHTML)
  function fillExample(container, example, word) {
    container.textContent = '';
    var lower = example.toLowerCase();
    var w = String(word || '').trim().toLowerCase();
    var idx = (w && lower.length === example.length) ? lower.indexOf(w) : -1;
    if (idx < 0) {
      container.appendChild(document.createTextNode(example));
      return;
    }
    var b = document.createElement('b');
    b.textContent = example.slice(idx, idx + w.length);
    container.appendChild(document.createTextNode(example.slice(0, idx)));
    container.appendChild(b);
    container.appendChild(document.createTextNode(example.slice(idx + w.length)));
  }

  // ---------- вкладки ----------
  function showTab(name) {
    var train = name === 'train';
    $('view-train').hidden = !train;
    $('view-deck').hidden = train;
    $('tab-train').classList.toggle('active', train);
    $('tab-deck').classList.toggle('active', !train);
    editingId = null;
    confirmId = null;
    if (train) { current = null; renderTrain(); } else { renderList(); }
  }

  // ---------- тренировка ----------
  function pickNext() {
    var best = null;
    var pool = data.cards.filter(inScope);
    pool.forEach(function (c) {
      if (pool.length > 1 && c.id === current) return;
      if (!best || c.due < best.due) best = c;
    });
    return best;
  }

  function renderTrain() {
    $('btn-dir').textContent = settings.reverse ? 'Перевод → слово' : 'Слово → перевод';
    renderTagBars();
    var empty = data.cards.length === 0;
    $('train-empty').hidden = !empty;
    $('train-box').hidden = empty;
    if (empty) return;

    var card = current && findCard(current);
    if (card && !inScope(card)) card = null;
    if (!card) {
      card = pickNext();
      current = card.id;
      flipped = false;
    }
    var front = settings.reverse ? card.translation : card.word;
    var back = settings.reverse ? card.word : card.translation;
    var frontLabel = settings.reverse ? 'Перевод' : 'Слово';
    var backLabel = settings.reverse ? 'Слово' : 'Перевод';

    $('card').classList.toggle('back', flipped);
    $('card-label').textContent = flipped ? backLabel : frontLabel;
    $('card-text').textContent = flipped ? back : front;

    var ex = card.example || '';
    // пример показываем только там, где видно слово (не рядом с переводом)
    var wordVisible = settings.reverse ? flipped : !flipped;
    var showEx = wordVisible && ex !== '';
    $('card-ex-box').hidden = !showEx;
    if (showEx) fillExample($('card-ex'), ex, card.word);

    var tr = card.transcription || '';
    var pos = labelOf(POS, card.pos || '');
    $('card-tr').textContent = wordVisible ? (card.accent ? accentLabel(card.accent) + ' ' : '') + tr : '';
    $('card-pos').textContent = wordVisible ? pos : '';
    $('card-tr').hidden = !(wordVisible && tr);
    $('card-pos').hidden = !(wordVisible && pos);
    $('card-level').textContent = 'Уровень ' + (card.box || 0);
    $('card-meta').hidden = !wordVisible;

    var note = card.note || '';
    $('card-note-box').hidden = !(wordVisible && note);
    $('card-note').textContent = wordVisible ? note : '';
    $('btn-speak').hidden = !wordVisible;

    $('btn-show').hidden = flipped;
    $('answer-btns').hidden = !flipped;
  }

  function flip() {
    if (!current) return;
    flipped = !flipped;
    renderTrain();
  }

  function answer(known) {
    var card = findCard(current);
    if (!card || !flipped) return;
    data.step += 1;
    if (known) {
      card.box = Math.min((card.box || 0) + 1, 5);
      card.due = data.step + 4 * Math.pow(2, card.box);
    } else {
      card.box = 0;
      card.due = data.step + 2;
    }
    save();
    flipped = false;
    // current остаётся прежним, чтобы pickNext не выдал её сразу же
    var next = pickNext();
    current = next.id;
    renderTrain();
  }

  function toggleDirection() {
    settings.reverse = !settings.reverse;
    saveSettings();
    flipped = false;
    renderTrain();
  }

  // ---------- колода ----------
  function matches(c, q) {
    if (!q) return true;
    return (c.word + '\n' + c.translation + '\n' + (c.example || '') + '\n' + (c.note || '') + '\n' +
      tagsOf(c).join('\n')).toLowerCase().indexOf(q) >= 0;
  }

  function renderList() {
    var list = $('list');
    list.textContent = '';
    renderTagBars();
    refreshAddHelpers();
    var q = query.trim().toLowerCase();
    var shown = data.cards.filter(function (c) { return inScope(c) && matches(c, q); });

    $('deck-empty').hidden = data.cards.length > 0;
    $('search-empty').hidden = !(data.cards.length > 0 && shown.length === 0);

    shown.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'item';

      if (c.id === editingId) {
        var w = document.createElement('input');
        w.value = c.word;
        w.setAttribute('aria-label', 'Слово');
        var t = document.createElement('input');
        t.value = c.translation;
        t.setAttribute('aria-label', 'Перевод');
        var x = document.createElement('input');
        x.value = c.example || '';
        x.placeholder = 'Пример (необязательно)';
        x.setAttribute('aria-label', 'Пример');
        var lg = document.createElement('select');
        lg.setAttribute('aria-label', 'Язык слова');
        makeSelect(lg, LANGS, c.lang);
        var tn = document.createElement('input');
        tn.value = c.transcription || '';
        tn.placeholder = 'Транскрипция';
        tn.setAttribute('aria-label', 'Транскрипция');
        var ps = document.createElement('select');
        ps.setAttribute('aria-label', 'Часть речи');
        makeSelect(ps, POS, c.pos);
        var nt2 = document.createElement('textarea');
        nt2.rows = 2;
        nt2.value = c.note || '';
        nt2.placeholder = 'Моя заметка (необязательно)';
        nt2.setAttribute('aria-label', 'Моя заметка');
        var tg = document.createElement('input');
        tg.value = tagsOf(c).join(', ');
        tg.placeholder = 'Тематики через запятую (необязательно)';
        tg.setAttribute('aria-label', 'Теги');
        var acc2 = c.accent || '';
        var err = document.createElement('p');
        err.className = 'error';
        err.hidden = true;
        var row = document.createElement('div');
        row.className = 'row';
        row.appendChild(button('Сохранить', 'btn', function () {
          var nw = w.value.trim(), nt = t.value.trim(), nx = x.value.trim();
          if (!nw || !nt) {
            err.textContent = 'Заполните слово и перевод';
            err.hidden = false;
            return;
          }
          if (isDuplicate(nw, c.id)) {
            err.textContent = 'Такая карточка уже есть';
            err.hidden = false;
            return;
          }
          c.word = nw;
          c.translation = nt;
          c.example = nx;
          c.lang = lg.value;
          c.transcription = tn.value.trim();
          c.accent = c.transcription ? acc2 : '';
          c.pos = ps.value;
          c.note = nt2.value.trim();
          c.tags = parseTags(tg.value);
          save();
          editingId = null;
          renderList();
        }));
        row.appendChild(button('Отмена', 'btn btn-light', function () {
          editingId = null;
          renderList();
        }));
        var sg = document.createElement('div');
        sg.className = 'sugg';
        var refresh = function () {
          fillSuggest(sg, w.value, lg.value, function (tr, acc) {
            tn.value = tr;
            acc2 = acc;
          });
        };
        w.addEventListener('input', refresh);
        lg.addEventListener('change', refresh);
        tn.addEventListener('input', function () { acc2 = ''; });
        refresh();
        var topRow = document.createElement('div');
        topRow.className = 'frow top';
        w.classList.add('f-word');
        var trCol = document.createElement('div');
        trCol.className = 'f-tr';
        trCol.appendChild(tn);
        trCol.appendChild(sg);
        [w, lg, trCol, ps].forEach(function (el) { topRow.appendChild(el); });
        var midRow = document.createElement('div');
        midRow.className = 'frow mid';
        var colR = document.createElement('div');
        colR.className = 'fcol';
        colR.appendChild(x);
        colR.appendChild(nt2);
        midRow.appendChild(t);
        midRow.appendChild(colR);
        li.appendChild(topRow);
        li.appendChild(midRow);
        li.appendChild(tg);
        li.appendChild(err);
        li.appendChild(row);
      } else {
        var text = document.createElement('div');
        text.className = 'item-text';
        var b = document.createElement('b');
        b.textContent = c.word;
        var s = document.createElement('span');
        s.className = 'item-tl';
        s.textContent = c.translation;
        var head = document.createElement('div');
        head.className = 'item-top';
        head.appendChild(b);
        var langLabel = c.lang ? labelOf(LANGS, c.lang) : '';
        if (langLabel) {
          var lc = document.createElement('span');
          lc.className = 'chip';
          lc.textContent = langLabel;
          head.appendChild(lc);
        }
        var lv = document.createElement('span');
        lv.className = 'chip';
        lv.textContent = 'Уровень ' + (c.box || 0);
        head.appendChild(lv);
        if (c.transcription) {
          var trs = document.createElement('span');
          trs.className = 'item-tr';
          trs.textContent = (c.accent ? accentLabel(c.accent) + ' ' : '') + c.transcription;
          head.appendChild(trs);
        }
        var posLabel = labelOf(POS, c.pos || '');
        if (posLabel) {
          var pc = document.createElement('span');
          pc.className = 'chip';
          pc.textContent = posLabel;
          head.appendChild(pc);
        }
        head.appendChild(button('🔊 Слушать', 'btn btn-light', function () { speak(c, li); }));
        text.appendChild(head);
        var mid = document.createElement('div');
        mid.className = 'item-mid';
        mid.appendChild(s);
        var right = document.createElement('div');
        right.className = 'item-right';
        if (c.example) {
          var ex = document.createElement('span');
          ex.className = 'item-ex';
          fillExample(ex, c.example, c.word);
          right.appendChild(ex);
        }
        if (c.note) {
          var nb = document.createElement('span');
          nb.className = 'item-note';
          nb.textContent = 'Заметка: ' + c.note;
          right.appendChild(nb);
        }
        if (right.childNodes.length) mid.appendChild(right);
        text.appendChild(mid);
        if (tagsOf(c).length) {
          var tl = document.createElement('div');
          tl.className = 'item-tags';
          tagsOf(c).forEach(function (tt) {
            var ch = document.createElement('span');
            ch.className = 'chip';
            ch.textContent = tt;
            tl.appendChild(ch);
          });
          text.appendChild(tl);
        }
        var row2 = document.createElement('div');
        row2.className = 'row';
        if (c.id === confirmId) {
          row2.appendChild(button('Удалить?', 'btn btn-no', function () {
            data.cards = data.cards.filter(function (y) { return y.id !== c.id; });
            if (current === c.id) current = null;
            confirmId = null;
            save();
            renderList();
          }));
          row2.appendChild(button('Отмена', 'btn btn-light', function () {
            confirmId = null;
            renderList();
          }));
        } else {
          row2.appendChild(button('Изменить', 'btn btn-light', function () {
            editingId = c.id;
            confirmId = null;
            renderList();
          }));
          row2.appendChild(button('Удалить', 'btn btn-no', function () {
            confirmId = c.id;
            renderList();
          }));
        }
        li.appendChild(text);
        li.appendChild(row2);
      }
      list.appendChild(li);
    });
  }

  function button(label, cls, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function addCard(e) {
    e.preventDefault();
    var w = $('in-word').value.trim();
    var t = $('in-trans').value.trim();
    var x = $('in-example').value.trim();
    var err = $('form-error');
    if (!w || !t) {
      err.textContent = 'Заполните слово и перевод';
      err.hidden = false;
      return;
    }
    if (isDuplicate(w, null)) {
      err.textContent = 'Такая карточка уже есть';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    data.cards.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      word: w,
      translation: t,
      example: x,
      lang: $('in-lang').value,
      transcription: $('in-tr').value.trim(),
      accent: $('in-tr').value.trim() ? addAccent : '',
      pos: $('in-pos').value,
      note: $('in-note').value.trim(),
      tags: parseTags($('in-tags').value),
      box: 0,
      due: data.step,
      nextReview: today(),
      history: [],
      known: 0,
      unknown: 0
    });
    settings.lastLang = $('in-lang').value;
    saveSettings();
    save();
    $('in-word').value = '';
    $('in-trans').value = '';
    $('in-example').value = '';
    $('in-tr').value = '';
    $('in-pos').value = '';
    $('in-note').value = '';
    $('in-tags').value = '';
    addAccent = '';
    $('in-word').focus();
    renderList();
    refreshAddHelpers();
  }

  // ---------- запуск ----------
  $('tab-train').addEventListener('click', function () { showTab('train'); });
  $('tab-deck').addEventListener('click', function () { showTab('deck'); });
  makeSelect($('in-lang'), LANGS, settings.lastLang);
  makeSelect($('in-pos'), POS, '');
  $('in-word').addEventListener('input', refreshAddHelpers);
  $('in-lang').addEventListener('change', refreshAddHelpers);
  $('in-tr').addEventListener('input', function () { addAccent = ''; });
  refreshAddHelpers();
  $('btn-speak').addEventListener('click', function () {
    var c = findCard(current);
    if (c) speak(c, $('train-box'));
  });
  $('card').addEventListener('click', flip);
  $('btn-show').addEventListener('click', flip);
  $('btn-known').addEventListener('click', function () { answer(true); });
  $('btn-unknown').addEventListener('click', function () { answer(false); });
  $('btn-dir').addEventListener('click', toggleDirection);
  $('add-form').addEventListener('submit', addCard);
  $('search').addEventListener('input', function () {
    query = $('search').value;
    renderList();
  });
  $('btn-reset').addEventListener('click', function () {
    $('search').value = '';
    query = '';
    renderList();
  });

  renderTrain();
})();
