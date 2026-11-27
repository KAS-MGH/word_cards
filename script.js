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
  var ttsEl = null, ttsHome = null, ttsNext = null;
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
        var good = d.cards.filter(function (c) {
          return c && typeof c === 'object' &&
            typeof c.word === 'string' && typeof c.translation === 'string';
        });
        var decks = normalizeDecks(d.decks);
        good.forEach(function (c, i) {
          if (typeof c.id !== 'string' || !c.id) {
            c.id = Date.now().toString(36) + i + Math.random().toString(36).slice(2, 6);
          }
          normalizeCard(c);
          // нет колоды или такой колоды нет — первая колода (спецификация 006)
          if (!decks.some(function (k) { return k.id === c.deck; })) c.deck = decks[0].id;
        });
        return { cards: good, step: d.step || 0, decks: decks };
      }
    } catch (e) { /* пусто или повреждено */ }
    return { cards: [], step: 0, decks: normalizeDecks(null) };
  }

  // всегда есть хотя бы одна колода; повреждённые записи отбрасываются
  function normalizeDecks(list) {
    var out = [];
    if (Array.isArray(list)) {
      list.forEach(function (k) {
        if (k && typeof k.id === 'string' && k.id && typeof k.name === 'string' && k.name.trim() &&
            !out.some(function (x) { return x.id === k.id; })) {
          out.push({ id: k.id, name: k.name });
        }
      });
    }
    if (!out.length) out.push({ id: 'main', name: 'Основная' });
    return out;
  }

  // активная колода: сохранённая или первая
  function activeDeck() {
    for (var i = 0; i < data.decks.length; i++) {
      if (data.decks[i].id === settings.activeDeck) return data.decks[i];
    }
    return data.decks[0];
  }

  function renderDeckName() {
    $('deck-name').textContent = 'Колода: ' + activeDeck().name;
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
          lastLang: typeof s.lastLang === 'string' ? s.lastLang : '',
          activeDeck: typeof s.activeDeck === 'string' ? s.activeDeck : null
        };
      }
    } catch (e) { /* ignore */ }
    return { reverse: false, activeTag: null, lastLang: '', activeDeck: null };
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
          resetSession();
          if (!$('view-train').hidden) renderTrain(); else renderList();
        });
        b.setAttribute('aria-pressed', settings.activeTag === t ? 'true' : 'false');
        bar.appendChild(b);
      });
    });
  }

  // ---------- озвучка ----------
  function ttsMessage(text, host) {
    // элемент и его исходное место запоминаем один раз: список очищается и уносит сообщение с собой
    if (!ttsEl) {
      ttsEl = $('tts-msg');
      ttsHome = ttsEl.parentNode;
      ttsNext = ttsEl.nextSibling;
    }
    var m = ttsEl;
    // показываем сообщение над словом: первым элементом в карточке, где нажали «Слушать»
    if (host && host.isConnected) host.insertBefore(m, host.firstChild);
    else if (!m.isConnected || (host && !host.isConnected)) ttsHome.insertBefore(m, ttsNext && ttsNext.parentNode === ttsHome ? ttsNext : null);
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
    var idx = -1;
    if (w && lower.length === example.length) {
      var isLetter = function (ch) { return !!ch && /[\p{L}\p{N}]/u.test(ch); };
      var from = 0;
      while (true) {
        var p = lower.indexOf(w, from);
        if (p < 0) break;
        if (!isLetter(lower.charAt(p - 1)) && !isLetter(lower.charAt(p + w.length))) { idx = p; break; }
        from = p + 1;
      }
    }
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
    $('view-deck').hidden = name !== 'deck';
    $('view-decks').hidden = name !== 'decks';
    $('tab-train').classList.toggle('active', train);
    $('tab-deck').classList.toggle('active', name === 'deck');
    $('tab-decks').classList.toggle('active', name === 'decks');
    editingId = null;
    confirmId = null;
    deckEditId = null;
    deckConfirmId = null;
    if (train) { current = null; renderTrain(); }
    else if (name === 'decks') { renderDecks(); }
    else { renderList(); }
  }

  // ---------- колоды (спецификация 006) ----------
  var deckEditId = null;     // колода, которую переименовывают
  var deckConfirmId = null;  // колода, ожидающая подтверждения удаления

  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function deckCount(id) {
    return data.cards.filter(function (c) { return c.deck === id; }).length;
  }

  // текст ошибки названия или '' (name уже без пробелов по краям)
  function deckNameError(name, exceptId) {
    if (!name) return 'Введите название';
    if (name.length > 30) return 'Не больше 30 символов';
    var n = name.toLowerCase();
    var dup = data.decks.some(function (k) { return k.id !== exceptId && k.name.trim().toLowerCase() === n; });
    return dup ? 'Такая колода уже есть' : '';
  }

  function renderDecks() {
    var list = $('deck-list');
    list.textContent = '';
    data.decks.forEach(function (k) {
      var li = document.createElement('li');
      li.className = 'item';
      if (k.id === deckEditId) {
        var inp = document.createElement('input');
        inp.value = k.name;
        inp.setAttribute('aria-label', 'Название колоды');
        var err = document.createElement('p');
        err.className = 'error';
        err.hidden = true;
        var row = document.createElement('div');
        row.className = 'row';
        var doSave = function () {
          var nm = inp.value.trim();
          var msg = deckNameError(nm, k.id);
          if (msg) { err.textContent = msg; err.hidden = false; return; }
          k.name = nm;
          deckEditId = null;
          save();
          renderDeckName();
          renderDecks();
        };
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSave(); });
        row.appendChild(button('Сохранить', 'btn', doSave));
        row.appendChild(button('Отмена', 'btn btn-light', function () {
          deckEditId = null;
          renderDecks();
        }));
        li.appendChild(inp);
        li.appendChild(err);
        li.appendChild(row);
      } else {
        var n = deckCount(k.id);
        var head = document.createElement('div');
        head.className = 'item-top';
        var b = document.createElement('b');
        b.textContent = k.name;
        head.appendChild(b);
        var cnt = document.createElement('span');
        cnt.className = 'chip';
        cnt.textContent = n + ' ' + plural(n, 'карточка', 'карточки', 'карточек');
        head.appendChild(cnt);
        li.appendChild(head);
        var row2 = document.createElement('div');
        row2.className = 'row';
        if (k.id === deckConfirmId) {
          var q = document.createElement('p');
          q.className = 'deck-q';
          q.textContent = 'Удалить колоду и ' + n + ' ' + plural(n, 'карточку', 'карточки', 'карточек') + '?';
          li.appendChild(q);
          row2.appendChild(button('Да, удалить', 'btn btn-no', function () { deleteDeck(k.id); }));
          row2.appendChild(button('Отмена', 'btn btn-light', function () {
            deckConfirmId = null;
            renderDecks();
          }));
        } else {
          row2.appendChild(button('Переименовать', 'btn btn-light', function () {
            deckEditId = k.id;
            deckConfirmId = null;
            renderDecks();
          }));
          if (data.decks.length > 1) {
            row2.appendChild(button('Удалить', 'btn btn-no', function () {
              deckConfirmId = k.id;
              deckEditId = null;
              renderDecks();
            }));
          } else {
            var last = document.createElement('p');
            last.className = 'small';
            last.textContent = 'Нужна хотя бы одна колода';
            row2.appendChild(last);
          }
        }
        li.appendChild(row2);
      }
      list.appendChild(li);
    });
  }

  function deleteDeck(id) {
    if (data.decks.length < 2) return;
    data.decks = data.decks.filter(function (k) { return k.id !== id; });
    data.cards = data.cards.filter(function (c) { return c.deck !== id; });
    if (settings.activeDeck === id) { settings.activeDeck = data.decks[0].id; saveSettings(); }
    deckConfirmId = null;
    resetSession();
    save();
    renderDeckName();
    renderDecks();
  }

  function createDeck(e) {
    e.preventDefault();
    var nm = $('deck-in').value.trim();
    var msg = deckNameError(nm, null);
    var err = $('deck-error');
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    err.hidden = true;
    data.decks.push({ id: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: nm });
    $('deck-in').value = '';
    save();
    renderDecks();
  }

  // ---------- тренировка ----------
  var INTERVALS = [0, 1, 3, 7, 14, 30];  // дней до повторения по уровням
  var sessionQ = null;   // очередь сессии: id карточек (только в памяти); null — собрать заново
  var failed = {};       // id карточек, на которые в этой сессии уже ответили «Не знаю»
  var practiceAll = false;  // «Тренировать всё равно»
  var repeatMode = false;   // «Повтор сложных»: уровни и даты не меняются
  var stats = { total: 0, known: 0, unknown: 0, first: {}, firstOk: 0 };  // счётчики для итога (только в памяти)

  function addDays(n) {
    var d = new Date();
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
  }

  // очередь: нужные на сегодня (или все, если «Тренировать всё равно»); раньше дата — раньше показ, при равенстве — меньший уровень
  function queue() {
    var t = today();
    return data.cards.filter(function (c) {
      return inScope(c) && (practiceAll || c.nextReview <= t);
    }).sort(function (a, b) {
      if (a.nextReview !== b.nextReview) return a.nextReview < b.nextReview ? -1 : 1;
      return a.box - b.box;
    });
  }

  function newStats(total) {
    return { total: total, known: 0, unknown: 0, first: {}, firstOk: 0 };
  }

  function renderSummary() {
    $('sum-total').textContent = stats.total;
    $('sum-answers').textContent = (stats.known + stats.unknown) + ' (Знаю ' + stats.known + ', Не знаю ' + stats.unknown + ')';
    $('sum-first').textContent = stats.firstOk + ' из ' + stats.total + ' (' +
      (stats.total ? Math.round(stats.firstOk * 100 / stats.total) : 0) + '%)';
    var hard = Object.keys(failed).map(findCard).filter(Boolean);
    $('sum-hardcount').textContent = hard.length;
    var list = $('sum-hard');
    list.textContent = '';
    hard.forEach(function (c) {
      var li = document.createElement('li');
      var b = document.createElement('b');
      b.textContent = c.word;
      li.appendChild(b);
      li.appendChild(document.createTextNode(' — ' + c.translation));
      list.appendChild(li);
    });
    $('sum-hard-box').hidden = hard.length === 0;
    $('btn-repeat').hidden = hard.length === 0;
  }

  // отдельная сессия только из сложных слов прошлой сессии
  function startRepeat() {
    var ids = Object.keys(failed).filter(function (id) { return findCard(id); });
    if (!ids.length) return;
    repeatMode = true;
    sessionQ = ids;
    failed = {};
    stats = newStats(ids.length);
    current = null;
    flipped = false;
    renderTrain();
  }

  function resetSession() {
    repeatMode = false;
    sessionQ = null;
    stats = newStats(0);
    failed = {};
    current = null;
    flipped = false;
  }

  function renderTrain() {
    $('btn-dir').textContent = settings.reverse ? 'Перевод → слово' : 'Слово → перевод';
    renderTagBars();
    var empty = data.cards.length === 0;
    $('train-empty').hidden = !empty;
    $('repeat-label').hidden = empty || !repeatMode;
    if (empty) {
      $('train-box').hidden = true;
      $('train-done').hidden = true;
      $('train-summary').hidden = true;
      return;
    }

    if (!sessionQ) {
      sessionQ = queue().map(function (c) { return c.id; });
      failed = {};
      stats = newStats(sessionQ.length);
    }
    // удалённые или выпавшие из выбранной области карточки убираем из очереди
    sessionQ = sessionQ.filter(function (id) {
      var c = findCard(id);
      return c && inScope(c);
    });
    var card = sessionQ.length ? findCard(sessionQ[0]) : null;
    var done = !card;
    var summary = done && stats.total > 0;
    $('train-done').hidden = !done || summary;
    $('train-summary').hidden = !summary;
    $('train-box').hidden = done;
    if (done) {
      current = null;
      flipped = false;
      if (summary) {
        renderSummary();   // сессия остаётся «пустой» в памяти до нажатия «Новая сессия»
      } else {
        practiceAll = false;
        sessionQ = null;
      }
      return;
    }
    if (current !== card.id) flipped = false;
    current = card.id;
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
    sessionQ.shift();
    if (!stats.first.hasOwnProperty(card.id)) {
      stats.first[card.id] = known;
      if (known) stats.firstOk += 1;
    }
    if (known) stats.known += 1; else stats.unknown += 1;
    if (repeatMode) {
      // повтор сложных: уровни, даты и счётчики не трогаем, только история
      if (!known) {
        failed[card.id] = true;
        sessionQ.splice(Math.min(3, sessionQ.length), 0, card.id);
      }
      card.history.push({ d: today(), ok: known, r: true });
    } else if (known) {
      // «Знаю» на повторе в той же сессии — уровень 1 и «завтра»
      card.box = failed[card.id] ? 1 : Math.min((card.box || 0) + 1, 5);
      card.nextReview = addDays(INTERVALS[card.box]);
      card.known += 1;
    } else {
      card.box = 0;
      card.nextReview = today();
      card.unknown += 1;
      failed[card.id] = true;
      // возвращаем примерно через 3 карточки (если очередь короче — в конец)
      sessionQ.splice(Math.min(3, sessionQ.length), 0, card.id);
    }
    if (!repeatMode) card.history.push({ d: today(), ok: known });
    if (card.history.length > 50) card.history = card.history.slice(-50);
    save();
    flipped = false;
    current = null;
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
    $('form-note').hidden = true;
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
      unknown: 0,
      deck: activeDeck().id
    });
    settings.lastLang = $('in-lang').value;
    saveSettings();
    save();
    // новая карточка попадает в тренировку: в идущую сессию — в конец очереди, после итога — новая сессия
    if (sessionQ && !repeatMode) {
      var added = data.cards[data.cards.length - 1];
      if (!sessionQ.length) {
        resetSession();
      } else if (inScope(added)) {
        sessionQ.push(added.id);
        stats.total++;
      }
    }
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
    if (!inScope(data.cards[data.cards.length - 1])) {
      $('form-note').textContent = 'Добавлено вне выбранной темы — нажмите «Все», чтобы увидеть';
      $('form-note').hidden = false;
    }
    refreshAddHelpers();
  }

  // ---------- запуск ----------
  $('tab-train').addEventListener('click', function () { showTab('train'); });
  $('tab-deck').addEventListener('click', function () { showTab('deck'); });
  $('tab-decks').addEventListener('click', function () { showTab('decks'); });
  $('deck-form').addEventListener('submit', createDeck);
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
  $('btn-practice').addEventListener('click', function () {
    practiceAll = true;
    resetSession();
    renderTrain();
  });
  $('btn-repeat').addEventListener('click', startRepeat);
  $('btn-new').addEventListener('click', function () {
    practiceAll = false;
    resetSession();
    renderTrain();
  });
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

  renderDeckName();
  renderTrain();
})();
