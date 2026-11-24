(function () {
  'use strict';

  var KEY = 'wordcards.v1';
  // data = { cards: [{id, word, translation, box, due}], step: число }
  var data = load();
  var current = null;   // id карточки в тренировке
  var flipped = false;
  var editingId = null;

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

  function findCard(id) {
    for (var i = 0; i < data.cards.length; i++) {
      if (data.cards[i].id === id) return data.cards[i];
    }
    return null;
  }

  // ---------- вкладки ----------
  function showTab(name) {
    var train = name === 'train';
    $('view-train').hidden = !train;
    $('view-deck').hidden = train;
    $('tab-train').classList.toggle('active', train);
    $('tab-deck').classList.toggle('active', !train);
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
    $('card').classList.toggle('back', flipped);
    $('card-label').textContent = flipped ? 'Перевод' : 'Слово';
    $('card-text').textContent = flipped ? card.translation : card.word;
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

  // ---------- колода ----------
  function renderList() {
    var list = $('list');
    list.textContent = '';
    $('deck-empty').hidden = data.cards.length > 0;

    data.cards.forEach(function (c) {
      var li = document.createElement('li');
      li.className = 'item';

      if (c.id === editingId) {
        var w = document.createElement('input');
        w.value = c.word;
        w.setAttribute('aria-label', 'Слово');
        var t = document.createElement('input');
        t.value = c.translation;
        t.setAttribute('aria-label', 'Перевод');
        var err = document.createElement('p');
        err.className = 'error';
        err.hidden = true;
        err.textContent = 'Заполните оба поля';
        var row = document.createElement('div');
        row.className = 'row';
        row.appendChild(button('Сохранить', 'btn', function () {
          var nw = w.value.trim(), nt = t.value.trim();
          if (!nw || !nt) { err.hidden = false; return; }
          c.word = nw;
          c.translation = nt;
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
        var row2 = document.createElement('div');
        row2.className = 'row';
        row2.appendChild(button('Изменить', 'btn btn-light', function () {
          editingId = c.id;
          renderList();
        }));
        row2.appendChild(button('Удалить', 'btn btn-no', function () {
          data.cards = data.cards.filter(function (x) { return x.id !== c.id; });
          if (current === c.id) current = null;
          save();
          renderList();
        }));
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
    var err = $('form-error');
    if (!w || !t) {
      err.textContent = 'Заполните слово и перевод';
      err.hidden = false;
      return;
    }
    err.hidden = true;
    data.cards.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      word: w,
      translation: t,
      box: 0,
      due: data.step
    });
    save();
    $('in-word').value = '';
    $('in-trans').value = '';
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
  $('add-form').addEventListener('submit', addCard);

  renderTrain();
})();
