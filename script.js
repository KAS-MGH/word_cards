(function () {
  'use strict';

  var KEY = 'wordcards.v1';
  var SETTINGS_KEY = 'wordcards.settings.v1';
  // data = { cards: [{id, word, translation, example?, box, due}], step: число }
  var data = load();
  var settings = loadSettings();   // { reverse: bool }
  var current = null;   // id карточки в тренировке
  var flipped = false;
  var editingId = null;
  var confirmId = null; // карточка, ожидающая подтверждения удаления
  var query = '';

  function $(id) { return document.getElementById(id); }

  function load() {
    try {
      var d = JSON.parse(localStorage.getItem(KEY));
      if (d && Array.isArray(d.cards)) return { cards: d.cards, step: d.step || 0 };
    } catch (e) { /* пусто или повреждено */ }
    return { cards: [], step: 0 };
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (s && typeof s === 'object') return { reverse: s.reverse === true };
    } catch (e) { /* ignore */ }
    return { reverse: false };
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
    data.cards.forEach(function (c) {
      if (data.cards.length > 1 && c.id === current) return;
      if (!best || c.due < best.due) best = c;
    });
    return best;
  }

  function renderTrain() {
    $('btn-dir').textContent = settings.reverse ? 'Перевод → слово' : 'Слово → перевод';
    var empty = data.cards.length === 0;
    $('train-empty').hidden = !empty;
    $('train-box').hidden = empty;
    if (empty) return;

    var card = current && findCard(current);
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
    var showEx = flipped && ex !== '';
    $('card-ex-box').hidden = !showEx;
    if (showEx) fillExample($('card-ex'), ex, card.word);

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
      card.box = Math.min((card.box || 0) + 1, 6);
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
    return (c.word + '\n' + c.translation + '\n' + (c.example || '')).toLowerCase().indexOf(q) >= 0;
  }

  function renderList() {
    var list = $('list');
    list.textContent = '';
    var q = query.trim().toLowerCase();
    var shown = data.cards.filter(function (c) { return matches(c, q); });

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
          save();
          editingId = null;
          renderList();
        }));
        row.appendChild(button('Отмена', 'btn btn-light', function () {
          editingId = null;
          renderList();
        }));
        li.appendChild(w);
        li.appendChild(t);
        li.appendChild(x);
        li.appendChild(err);
        li.appendChild(row);
      } else {
        var text = document.createElement('div');
        text.className = 'item-text';
        var b = document.createElement('b');
        b.textContent = c.word;
        var s = document.createElement('span');
        s.textContent = c.translation;
        text.appendChild(b);
        text.appendChild(s);
        if (c.example) {
          var ex = document.createElement('span');
          ex.className = 'item-ex';
          fillExample(ex, c.example, c.word);
          text.appendChild(ex);
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
      box: 0,
      due: data.step
    });
    save();
    $('in-word').value = '';
    $('in-trans').value = '';
    $('in-example').value = '';
    $('in-word').focus();
    renderList();
  }

  // ---------- запуск ----------
  $('tab-train').addEventListener('click', function () { showTab('train'); });
  $('tab-deck').addEventListener('click', function () { showTab('deck'); });
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
