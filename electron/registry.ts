import { app, type IpcMain, type Shell, type WebFrameMain } from 'electron';
import type {
  CatalogRequest,
  EmbedMenuGroup,
  FrameRect,
  MediaDetails,
  MediaSummary,
  PagedResult,
  SearchRequest,
  SourceInfo,
  StageCtlResult,
  StageState,
  StreamsRequest,
  StreamCatalog,
} from './models';
import { resolveEmbed } from './parsers/embed-resolver';
import { KinogoParser } from './parsers/kinogo';
import { KinokongParser } from './parsers/kinokong';
import { LordfilmParser } from './parsers/lordfilm';
import { ReYohohoParser } from './parsers/reyohoho';
import { ReYoHoHoRuParser } from './parsers/reyoho';
import { RutubeParser } from './parsers/rutube';
import { ZetflixParser } from './parsers/zetflix';
import { ZonaParser } from './parsers/zona';
import { LocalSourceParser } from './parsers/local';
import { registerStateStore } from './state-store';
import type { SourceParser } from './parsers/base';

let activeEmbedReferer: string | undefined;

export function getActiveEmbedReferer(): string | undefined {
  return activeEmbedReferer;
}

/** «1m30s» / «90» / «1h2m3s» → seconds for the embed's `start` param. */
function startSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * YouTube refuses to play embeds without a matching Referer, and the app
 * loads iframes from file:// (error 153). The nocookie embed origin paired
 * with a `youtube-nocookie.com` Referer (set in main.ts) plays reliably, so
 * any watch/youtu.be/shorts URL is rewritten to it.
 */
export function toYouTubeEmbed(url: string): string | undefined {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    let id = '';
    if (host.endsWith('youtu.be')) {
      id = u.pathname.split('/')[1] ?? '';
    } else {
      // path ids first: /live/<id>?v=… must not pick up the query junk
      id = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})(?:\/|$)/)?.[1] ?? '';
      if (!id) id = u.searchParams.get('v') ?? '';
    }
    if (!/^[\w-]{11}$/.test(id)) return undefined;
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    const start = startSeconds(u.searchParams.get('t') ?? u.searchParams.get('start'));
    if (start) embed.searchParams.set('start', String(start));
    return embed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Ядро скрипта сканирования меню embed-плеера (для острова контролов):
 * находит группы настроек — «Качество», «Озвучка», … — с пунктами и ссылками
 * на DOM-узлы (узлы нужны только внутри скрипта для клика; наружу уходят
 * лишь name/label/active). Работает в кросс-доменных фреймах.
 */
const MENU_CORE = `
function fbClean(s) { return String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); }
/** Активность пункта: токены класса (с защитой от not-/un-/in-) либо aria. */
function fbActive(el) {
  var cls = typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '';
  var tk = cls.split(/[\\s_-]+/);
  var neg = { not: 1, un: 1, no: 1, non: 1, dis: 1, in: 1 };
  for (var i = 0; i < tk.length; i++) {
    if (neg[tk[i - 1]]) continue;
    if (/^(active|pressed|selected|checked|current|now)$/.test(tk[i])) return true;
  }
  return el.getAttribute('aria-checked') === 'true' ||
    el.getAttribute('aria-selected') === 'true' ||
    el.getAttribute('aria-pressed') === 'true';
}
// zona/video.js (kinoserial): окно настроек создаётся только пока открыто
function fbZonaBtn() {
  var btns = document.querySelectorAll('.vjs-control-bar button, .vjs-control-bar [role="button"]');
  for (var i = 0; i < btns.length; i++) {
    var t = (btns[i].textContent || '') + ' ' + (btns[i].getAttribute('aria-label') || '') + ' ' + (btns[i].title || '');
    if (/Качество/i.test(t)) return btns[i];
  }
  return null;
}
function fbZonaSeq(b) {
  ['mouseout', 'mouseover', 'mouseenter', 'mousemove', 'mousedown', 'mouseup', 'click'].forEach(function (t) {
    b.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  });
}
function fbZonaMask() {
  if (document.getElementById('fb-zona-mask')) return;
  var zm = document.createElement('style');
  zm.id = 'fb-zona-mask';
  // popup сезонов тоже прячем: мы держим его открытым (внутри — состояние
  // выбранного сезона, пересоздание окна сбрасывает его), но поверх видео
  // оно висеть не должно
  zm.textContent =
    '.vjs-settings-popup,.vjs-settings-popup.vjs-settings-popup-visible{display:none!important}' +
    '.vjs-seasons-popup{display:none!important}';
  (document.head || document.documentElement).appendChild(zm);
}
// Для прихора клик по опциям качества киноserial работает только когда
// popup видимый — временно снимаем маску.
function fbZonaUnmask() {
  var st = document.getElementById('fb-zona-mask');
  if (st && st.parentNode) st.parentNode.removeChild(st);
}
/**
 * Открыть окно настроек зоны: элемент создаётся синхронно в showPopup;
 * класс -visible добавляется лишь через 150мс, поэтому опираемся на сам
 * элемент. Полный mouse-набор — их handleClick (vjs) распознаёт toggle.
 */
function fbZonaOpen() {
  var p = document.querySelector('.vjs-settings-popup');
  var b = fbZonaBtn();
  if (!b && !p) return null;
  fbZonaMask();
  if (p) return p;
  // dyn-hide/隐藏的 control-bar：把按钮临时显示出来再触发，避免 click 失效
  var wasHidden = false;
  try {
    wasHidden = getComputedStyle(b).display === 'none';
  } catch (e) {}
  if (wasHidden) b.style.setProperty('display', 'inline-block', 'important');
  var seq = (typeof fbZonaSeq === 'function') ? fbZonaSeq(b) : b.click();
  void seq;
  if (wasHidden) {
    try { b.style.removeProperty('display'); } catch (e) {}
  }
  return document.querySelector('.vjs-settings-popup');
}
/**
 * Закрыть окно их собственным closeBtn (→ hidePopup: overlay убирается
 * синхронно, элемент — через 200мс; popup-ноль выставляется там же).
 * Никогда не удалять элемент вручную — их кнопка держит ссылку на popup
 * до hidePopup и уходит в «закрыто», ломая следующие открытия.
 */
function fbZonaClose() {
  var cb = document.querySelector('.vjs-settings-closeBtn');
  if (cb) cb.click();
}
function fbDiscover() {
  var groups = [];
  var add = function (name, items, nodes) {
    name = fbClean(name);
    if (!name || !items.length) return;
    var key = name.toLowerCase();
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].name.toLowerCase() === key) {
        if (items.length > groups[i].items.length) {
          groups[i].items = items;
          groups[i].nodes = nodes;
        }
        return;
      }
    }
    groups.push({ name: name, items: items, nodes: nodes });
  };

  // allplay (stravers, kinogo): контейнер настроек с заголовками групп
  var conts = document.querySelectorAll('.allplay__menu__container');
  for (var c = 0; c < conts.length; c++) {
    var seq = conts[c].querySelectorAll('.allplay__control--name, .allplay__control');
    var cur = '', its = [], nds = [];
    for (var s = 0; s < seq.length; s++) {
      var el = seq[s];
      if ((' ' + el.className + ' ').indexOf(' allplay__control--name ') >= 0) {
        if (cur) add(cur, its, nds);
        cur = el.textContent || '';
        its = [];
        nds = [];
        continue;
      }
      if (/back|forward/.test(el.className || '')) continue;
      var t = el.querySelector('.allplay__control__title');
      var lb = fbClean(t ? t.textContent : el.textContent);
      if (!lb) continue;
      its.push({
        label: lb,
        active: fbActive(el),
      });
      nds.push(el);
    }
    if (cur) add(cur, its, nds);
  }

  // верхний левый селект stravers («Дублированный 4K») — качество+озвучка;
  // добавляем только если отдельных групп «Качество»/«Озвучка» уже нет
  var drops = document.querySelectorAll('.select__drop-item');
  var dIts = [], dNds = [];
  for (var d = 0; d < drops.length; d++) {
    var dl = fbClean(drops[d].textContent);
    if (!dl) continue;
    dIts.push({
      label: dl,
      active: fbActive(drops[d]),
    });
    dNds.push(drops[d]);
  }
  var merged = false;
  for (var q = 0; q < groups.length; q++) {
    if (/качеств|озвуч|quality|audio/i.test(groups[q].name)) { merged = true; break; }
  }
  if (dIts.length && !merged) {
    var holder = document.querySelector('.select__item');
    var gname = (holder && (holder.getAttribute('aria-label') || holder.getAttribute('title'))) ||
      'Озвучка/качество';
    add(gname, dIts, dNds);
  }

  // zona/video.js (kinoserial): полноэкранное окно «Качество и озвучка» —
  // создаётся при открытии и удаляется при закрытии; пункты читаются здесь,
  // закрытие — на уровне menuScript/pickScript (узлы нужны живыми для клика)
  var zp = fbZonaOpen();
  if (zp) {
    var zBlocks = [
      ['.vjs-quality-block .vjs-quality-option', 'Качество'],
      ['.vjs-audio-block .vjs-audio-option', 'Озвучка'],
    ];
    for (var zi = 0; zi < zBlocks.length; zi++) {
      var zbtns = zp.querySelectorAll(zBlocks[zi][0]);
      var zRows = [];
      for (var zb = 0; zb < zbtns.length; zb++) {
        var zmain = zbtns[zb].querySelector('.vjs-button-option-text');
        var zstream = zbtns[zb].querySelector('.vjs-button-option-text-stream');
        var zlabel = fbClean(zmain ? zmain.textContent : zbtns[zb].textContent);
        if (!zlabel) continue;
        zRows.push({
          label: zlabel,
          stream: zstream ? fbClean(zstream.textContent) : '',
          active: fbActive(zbtns[zb]),
          node: zbtns[zb],
        });
      }
      // суффикс потока и номер — только чтобы различать дубли имён
      var zSeen = {}, zDups = {};
      for (var zr = 0; zr < zRows.length; zr++) {
        if (zSeen[zRows[zr].label]) zDups[zRows[zr].label] = 1;
        zSeen[zRows[zr].label] = 1;
      }
      var zFinal = {}, zIts = [], zNds = [];
      for (var zr2 = 0; zr2 < zRows.length; zr2++) {
        var zlb = zRows[zr2].label;
        if (zDups[zlb] && zRows[zr2].stream) zlb = zlb + ' · ' + zRows[zr2].stream;
        var zkey = zlb, zn = 1;
        while (zFinal[zlb]) { zlb = zkey + ' #' + ++zn; }
        zFinal[zlb] = 1;
        zIts.push({ label: zlb, active: zRows[zr2].active });
        zNds.push(zRows[zr2].node);
      }
      if (zIts.length) add(zBlocks[zi][1], zIts, zNds);
    }
  }

  // zona/video.js (kinoserial): сезоны/серии — popup создаётся только
  // после клика по .vjs-seasons-button, поэтому открываем (маска скрывает
  // popup снаружи), читаем, и закрываем, только если открывали сами —
  // иначе можно закрыть окно, которое открыл пользователь.
  var zSB = document.querySelector('.vjs-seasons-button');
  if (zSB) {
    var zSP = document.querySelector('.vjs-seasons-popup');
    var zOpenedNow = false;
    // dyn-hide прячет «сезонные» элементы при серийном hint — для открытия
    // popup кнопку временно возвращаем (inline !important бьёт CSS !important)
    var zWasHidden = false;
    try {
      zWasHidden = getComputedStyle(zSB).display === 'none';
    } catch (e) {}
    if (zWasHidden) zSB.style.setProperty('display', 'inline-block', 'important');
    if (!zSP) {
      try { fbZonaSeq(zSB); } catch (e) {}
      zSP = document.querySelector('.vjs-seasons-popup');
      zOpenedNow = !!zSP;
    }
    if (zSP) {
      fbZonaMask();
      var zTabs = zSP.querySelectorAll('.vjs-seasons-tab');
      var sIts = [], sNds = [];
      for (var zt = 0; zt < zTabs.length; zt++) {
        var ztl = fbClean(zTabs[zt].textContent);
        if (!ztl) continue;
        sIts.push({ label: ztl, active: fbActive(zTabs[zt]) });
        sNds.push(zTabs[zt]);
      }
      if (sIts.length) add('Сезон', sIts, sNds);
      var zEps = zSP.querySelectorAll('.vjs-seasons-episode');
      var eIts = [], eNds = [];
      for (var ze = 0; ze < zEps.length; ze++) {
        var zet = zEps[ze].querySelector('.vjs-seasons-episode-title');
        var zen = zEps[ze].querySelector('.vjs-seasons-episode-number');
        var zTitle = fbClean(zet ? zet.textContent : '');
        // «1.» + «Серия 1» → «Серия 1»; фолбэк — весь текст кнопки
        var zlb = zTitle || fbClean(zEps[ze].textContent);
        if (!zlb) continue;
        eIts.push({ label: zlb, active: fbActive(zEps[ze]) });
        eNds.push(zEps[ze]);
      }
      if (eIts.length) add('Серия', eIts, eNds);
      // popup открываем только для чтения и закрываем: сезон «записан»
      // в entity (через select_episode при пике сезона), поэтому свежее
      // открытие покажет уже выбранный сезон; оставленное открытым окно
      // мешало другим веткам (например, выбору качества).
      if (zOpenedNow) {
        var zsc = document.querySelector('.vjs-seasons-closeBtn');
        if (zsc) zsc.click();
      }
      if (zWasHidden) {
        try { zSB.style.removeProperty('display'); } catch (e) {}
      }
    }
  }

  // stravers/allplay (Alloha в reyoho/kinogo): верхние селекты
  // Сезон/Серия/Озвучка как div.select с button.select__item (текущее
  // значение) и button.select__drop-item (все варианты). Группа из
  // data-select, иначе — по тексту текущего пункта.
  var fbSelectCat = function (attr, cur) {
    attr = String(attr || '').toLowerCase();
    if (/season/.test(attr)) return 'Сезон';
    if (/episode|seria|part/.test(attr)) return 'Серия';
    if (/translation|voice|audio|dub|voiceover/.test(attr)) return 'Озвучка';
    if (/quality/.test(attr)) return 'Качество';
    if (/speed/.test(attr)) return 'Скорость';
    if (/subtitle|caption/.test(attr)) return 'Субтитры';
    cur = String(cur || '');
    if (/сезон|season/i.test(cur)) return 'Сезон';
    if (/серия|сери|episode/i.test(cur)) return 'Серия';
    if (/скорост|speed|×|х/i.test(cur)) return 'Скорость';
    if (/^\d{3,4}p|качеств|quality/i.test(cur)) return 'Качество';
    if (/авто|auto/i.test(cur)) return 'Качество';
    return 'Озвучка';
  };
  var selDivs = document.querySelectorAll('div.select');
  for (var sd = 0; sd < selDivs.length; sd++) {
    var block = selDivs[sd];
    if ((' ' + (block.className || '') + ' ').indexOf(' hidden ') >= 0) continue;
    var curBtn = block.querySelector('.select__item-text, .select__item');
    var curText = curBtn ? fbClean(curBtn.textContent) : '';
    var cat = fbSelectCat(block.getAttribute('data-select'), curText);
    var items = block.querySelectorAll('.select__drop-item');
    var aIts = [], aNds = [];
    for (var si = 0; si < items.length; si++) {
      var sit = fbClean(items[si].textContent);
      if (!sit) continue;
      aIts.push({ label: sit.replace(/\s+4K$/, '').replace(/\s+$/, ''), active: fbActive(items[si]) });
      aNds.push(items[si]);
    }
    if (aIts.length) add(cat, aIts, aNds);
  }

  // Нативные <select> embed-плееров (Turbo/Collaps и похожие): группа —
  // по name/aria-label/тексту текущего пункта; пропускаем нетипичные
  // (стили субтитров, масштаб).
  var natCat = function (sel) {
    var hints = [sel.getAttribute('data-select'), sel.name, sel.id, sel.getAttribute('aria-label')]
      .map(function (x) { return String(x || '').toLowerCase(); })
      .join(' ');
    if (/season/.test(hints)) return 'Сезон';
    if (/episode|seria/.test(hints)) return 'Серия';
    if (/translation|voice|audio|dub/.test(hints)) return 'Озвучка';
    if (/quality/.test(hints)) return 'Качество';
    if (/speed/.test(hints)) return 'Скорость';
    if (/subtitle|caption/.test(hints)) return 'Субтитры';
    var cur = sel.options && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : '';
    var lab = sel.parentElement ? fbClean(sel.parentElement.querySelector('label,.label,span') ? sel.parentElement.querySelector('label,.label,span').textContent : '') : '';
    cur = cur + ' ' + lab;
    if (/сезон|season/i.test(cur)) return 'Сезон';
    if (/серия|episode/i.test(cur)) return 'Серия';
    if (/скорост|speed|×/i.test(cur)) return 'Скорость';
    if (/^\d{3,4}p|качеств/i.test(cur)) return 'Качество';
    if (sel.options.length && /сезон|серия|озвуч|качеств|скорост|перевод|дубляж/i.test((sel.options[0].text || '') + ' ' + (sel.options[sel.options.length - 1].text || ''))) return null;
    return null;
  };
  var natSels = document.querySelectorAll('select');
  for (var ns = 0; ns < natSels.length; ns++) {
    var ncat = natCat(natSels[ns]);
    if (!ncat) continue;
    var nIts = [], nNds = [];
    for (var no = 0; no < natSels[ns].options.length; no++) {
      var nt = fbClean(natSels[ns].options[no].text);
      if (!nt) continue;
      nIts.push({ label: nt, active: no === natSels[ns].selectedIndex });
      nNds.push(natSels[ns]);
    }
    if (nIts.length > 1) add(ncat, nIts, nNds);
  }

  // generic: ищем любые кнопки/селекты с текстом про качество/озвучку
  var genericSelectors = [
    'button, [role="button"], .btn, .control, [class*="quality" i], [class*="voice" i], [class*="audio" i]',
  ];
  var genericItems = [];
  var genericNodes = [];
  for (var g = 0; g < genericSelectors.length; g++) {
    var els = document.querySelectorAll(genericSelectors[g]);
    for (var gi = 0; gi < els.length; gi++) {
      var el = els[gi];
      var txt = fbClean(el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '');
      if (!txt) continue;
      if (/качеств|озвуч|quality|voice|audio|субтитр|subtitle/i.test(txt)) {
        // пропускаем контейнеры с дочерними элементами
        if (el.children.length > 0 && el.querySelectorAll('button, [role="button"], .btn').length > 0) continue;
        genericItems.push({ label: txt, active: fbActive(el) });
        genericNodes.push(el);
      }
    }
  }
  if (genericItems.length) {
    var hasQuality = false, hasVoice = false;
    for (var q = 0; q < groups.length; q++) {
      if (/качеств|quality/i.test(groups[q].name)) hasQuality = true;
      if (/озвуч|voice|audio/i.test(groups[q].name)) hasVoice = true;
    }
    if (!hasQuality && !hasVoice) {
      add('Качество/Озвучка', genericItems, genericNodes);
    }
  }

  return groups;
}
function fbPublic(groups) {
  var out = [];
  for (var i = 0; i < groups.length; i++) {
    out.push({ name: groups[i].name, items: groups[i].items });
  }
  return out;
}
`;

/** Прочитать меню embed-плеера и скрыть его оригинальные селекты. */
const menuScript = `(function () {
  try {
${MENU_CORE}
    var groups = fbDiscover();
    var st = document.getElementById('fb-hide-menus');
    if (groups.length && !st) {
      st = document.createElement('style');
      st.id = 'fb-hide-menus';
      st.textContent =
        '.select__item,.select__drop,' +
        '[class*="quality" i]:not(:has(video)):not(:has(iframe))' +
        '{display:none!important}';
      (document.head || document.documentElement).appendChild(st);
    } else if (!groups.length && st && st.parentNode) {
      st.parentNode.removeChild(st);
    }
    var out = JSON.stringify({ groups: fbPublic(groups) });
    // settings-popup не закрываем: closeBtn убивает элемент через 200мс, и
    // следующий пик/чтение попадает в умирающее окно (выбор качества
    // «отваливался»). Окно всегда спрятано fbZonaMask — на плеер не влияет,
    // а fbZonaOpen переиспользует существующий элемент.
    return out;
  } catch (err) {
    return JSON.stringify({ groups: [] });
  }
})()`;

/** Клик по пункту меню embed-плеера, затем повторное чтение меню. */
const pickScript = (group: string, label: string): string =>
  `(function (group, label) {
  try {
${MENU_CORE}
    var groups = fbDiscover();
    for (var i = 0; i < groups.length; i++) {
      if (groups[i].name !== group) continue;
      for (var j = 0; j < groups[i].items.length; j++) {
        if (groups[i].items[j].label === label && groups[i].nodes[j]) {
          var zn = groups[i].nodes[j];
          // нативные <select>: клик не выбирает пункт — ищем опцию с
          // совпадающим текстом и диспатчим change
          if (zn && zn.tagName === 'SELECT') {
            for (var so = 0; so < zn.options.length; so++) {
              if (fbClean(zn.options[so].text) === label) {
                zn.selectedIndex = so;
                try { zn.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {}
                try { zn.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
                break;
              }
            }
            return new Promise(function (resolve) {
              setTimeout(function () {
                var out;
                try {
                  out = JSON.stringify({ groups: fbPublic(fbDiscover()) });
                } catch (e) {
                  out = JSON.stringify({ groups: [] });
                }
                resolve(out);
              }, 350);
            });
          }
          // zona/video.js: узлы сезонов/серий живут в popup, который
          // fbDiscover закрывает после чтения, а kino serial перерисовывает
          // список — к моменту клика zn может быть отсоединён от DOM.
          // Поэтому popup открывается заново, а пункт ищется свежим.
          var isZonaSe =
            zn.classList &&
            (zn.classList.contains('vjs-seasons-tab') ||
              zn.classList.contains('vjs-seasons-episode'));
          if (isZonaSe) {
            return new Promise(function (resolve) {
              var isTab = zn.classList.contains('vjs-seasons-tab');
              var sel = isTab ? '.vjs-seasons-tab' : '.vjs-seasons-episode';
              function zClickSbtn() {
                var sb = document.querySelector('.vjs-seasons-button');
                if (!sb) return;
                var hid = false;
                try {
                  hid = getComputedStyle(sb).display === 'none';
                } catch (e) {}
                if (hid) sb.style.setProperty('display', 'inline-block', 'important');
                try {
                  fbZonaSeq(sb);
                } catch (e) {
                  try {
                    sb.click();
                  } catch (e2) {}
                }
                if (hid) sb.style.removeProperty('display');
              }
              function zDoClick() {
                var popup = document.querySelector('.vjs-seasons-popup');
                var cand = popup ? popup.querySelectorAll(sel) : [];
                var fresh = null;
                for (var ci = 0; ci < cand.length; ci++) {
                  var clbl;
                  if (isTab) {
                    clbl = fbClean(cand[ci].textContent);
                  } else {
                    var ct = cand[ci].querySelector('.vjs-seasons-episode-title');
                    clbl = fbClean(ct ? ct.textContent : cand[ci].textContent);
                  }
                  if (clbl === label) {
                    fresh = cand[ci];
                    break;
                  }
                }
                if (!fresh) fresh = zn;
                var zFinish = function () {
                  setTimeout(function () {
                    var out;
                    try {
                      out = JSON.stringify({ groups: fbPublic(fbDiscover()) });
                    } catch (e) {
                      out = JSON.stringify({ groups: [] });
                    }
                    resolve(out);
                  }, 900);
                };
                // таб сезона уже активен — трогать нечего (иначе выбор
                // серии перезапущен бы был на первую)
                if (isTab && fresh && fresh.className.indexOf('active') !== -1) {
                  zFinish();
                  return;
                }
                // маску не снимаем: popup и так display:none (их собственный
                // CSS), клики по DOM-узлам от видимости не зависят
                try {
                  fresh.click();
                } catch (e) {
                  try {
                    fbZonaSeq(fresh);
                  } catch (e2) {}
                }
                if (!isTab) {
                  zFinish();
                  return;
                }
                // Выбор сезона в kino serial — временное состояние окна:
                // closeBtn/auto-close удаляет popup, и следующее открытие
                // строит его заново с сезоном по умолчанию. «Записать»
                // сезон можно только кликом по его серии: select_episode
                // уходит в msx, плеер перестраивается на этот сезон — и
                // все дальнейшие чтения (включая переоткрытый popup)
                // уже показывают новый сезон.
                var zCommit = function (n) {
                  var ts = document.querySelectorAll('.vjs-seasons-tab');
                  var activeOk = false;
                  for (var ti = 0; ti < ts.length; ti++) {
                    if (
                      fbClean(ts[ti].textContent) === label &&
                      ts[ti].className.indexOf('active') !== -1
                    ) {
                      activeOk = true;
                      break;
                    }
                  }
                  if (!activeOk && n < 12) {
                    setTimeout(function () {
                      zCommit(n + 1);
                    }, 100);
                    return;
                  }
                  if (activeOk) {
                    // первая серия нового сезона — она же закрепляет сезон
                    var eps = document.querySelectorAll('.vjs-seasons-episode');
                    if (eps.length) {
                      try {
                        eps[0].click();
                      } catch (e) {}
                    }
                  }
                  zFinish();
                };
                setTimeout(function () {
                  zCommit(0);
                }, 400);
              }
              // Окно читаем как есть: открытое (-visible) не трогаем,
              // закрытое — открываем заново (дождавшись уничтожения старого),
              // после клика не закрываем — poll-чтения его переиспользуют.
              function zStep(n, t0) {
                var p = document.querySelector('.vjs-seasons-popup');
                var vis = !!p && (p.className || '').indexOf('vjs-seasons-popup-visible') !== -1;
                if (vis || Date.now() - t0 > 2000) {
                  zDoClick();
                  return;
                }
                if (p) {
                  // окно в процессе закрытия (destroy в пути) — ждём исчезновения
                  setTimeout(function () {
                    zStep(n + 1, t0);
                  }, 100);
                  return;
                }
                zClickSbtn();
                setTimeout(function () {
                  zStep(n + 1, t0);
                }, 450);
              }
              zStep(0, Date.now());
            });
          }
          // zona/video.js: клик по качеству лишь помечает pending — поток
          // применяет только выбор озвучки (их Rb после Db).
          var isZonaQuality = zn.classList && zn.classList.contains('vjs-quality-option');
          if (!isZonaQuality) {
            // киноserial переключает табы/серии только при visible popup —
            // mask делает это невидимым, поэтому временно снимаем
            try { fbZonaUnmask(); } catch (e) {}
            zn.click();
          }
          if (isZonaQuality) {
            return new Promise(function (resolve) {
              function finish() {
                var out;
                try {
                  out = JSON.stringify({ groups: fbPublic(fbDiscover()) });
                } catch (e) {
                  out = JSON.stringify({ groups: [] });
                }
                resolve(out);
              }
              function zOpenSett() {
                var zbtn = null;
                var btns = document.querySelectorAll(
                  '.vjs-control-bar button, .vjs-control-bar [role="button"]',
                );
                for (var bi0 = 0; bi0 < btns.length; bi0++) {
                  var bt =
                    (btns[bi0].textContent || '') +
                    ' ' +
                    (btns[bi0].getAttribute('aria-label') || '') +
                    ' ' +
                    (btns[bi0].title || '');
                  if (/качество/i.test(bt)) {
                    zbtn = btns[bi0];
                    break;
                  }
                }
                if (!zbtn) return;
                try {
                  zbtn.style.setProperty('display', 'inline-block', 'important');
                } catch (e) {}
                try {
                  fbZonaSeq(zbtn);
                } catch (e) {}
                try {
                  zbtn.style.removeProperty('display');
                } catch (e) {}
              }
              // живое открытое окно: popup без -visible — это умирающее
              // (closeBtn убивает элемент через 200мс) или только что
              // открытое (класс ставится через ~150мс) — ждём стабилизации,
              // при исчезновении открываем заново. Танцу нужны живые узлы:
              // клик по отсоединённому popup ничего не применяет.
              function zSett(n, cb) {
                var p = document.querySelector('.vjs-settings-popup');
                if (p && p.isConnected && (p.className || '').indexOf('-visible') !== -1) {
                  cb(p);
                  return;
                }
                if (n >= 8) {
                  cb(p);
                  return;
                }
                if (!p || !p.isConnected) zOpenSett();
                setTimeout(function () {
                  zSett(n + 1, cb);
                }, 250);
              }
              // киноserial полагает качество pending-точкой только если
              // popup виден — mask не даёт этому сработать
              try {
                fbZonaUnmask();
              } catch (e) {}
              zSett(0, function (popup) {
                var qopts = popup ? popup.querySelectorAll('.vjs-quality-option') : [];
                var fresh = null;
                for (var qi = 0; qi < qopts.length; qi++) {
                  var qt = qopts[qi].querySelector('.vjs-button-option-text');
                  if (qt && fbClean(qt.textContent) === label) {
                    fresh = qopts[qi];
                    break;
                  }
                }
                if (fresh) fresh.click();
                setTimeout(function () {
                  zSett(0, function (p2) {
                    var auds = p2 ? p2.querySelectorAll('.vjs-audio-option') : [];
                    var audActiveEl = p2
                      ? p2.querySelector('.vjs-audio-option-active') || auds[0]
                      : null;
                    var audTxt = audActiveEl
                      ? fbClean(audActiveEl.querySelector('.vjs-button-option-text').textContent)
                      : null;
                    if (audActiveEl) audActiveEl.click();
                    setTimeout(function () {
                      zSett(0, function (p3) {
                        var qActiveNow = p3 ? p3.querySelector('.vjs-quality-option-active') : null;
                        var qText = qActiveNow
                          ? fbClean(qActiveNow.querySelector('.vjs-button-option-text').textContent)
                          : null;
                        if (qText === label) {
                          setTimeout(finish, 700);
                          return;
                        }
                        // pending не применился — дёргаем другую озвучку и
                        // возвращаем исходную (применение идёт по их Rb)
                        var auds3 = p3 ? p3.querySelectorAll('.vjs-audio-option') : [];
                        var backEl = null;
                        var audOther = null;
                        for (var ai2 = 0; ai2 < auds3.length; ai2++) {
                          var at = fbClean(
                            auds3[ai2].querySelector('.vjs-button-option-text').textContent,
                          );
                          if (audTxt && at === audTxt) backEl = auds3[ai2];
                          if (
                            !auds3[ai2].className.includes('-active') &&
                            !auds3[ai2].disabled &&
                            !audOther
                          ) {
                            audOther = auds3[ai2];
                          }
                        }
                        if (audOther) audOther.click();
                        if (audOther && backEl) {
                          setTimeout(function () {
                            try {
                              backEl.click();
                            } catch (e) {}
                            setTimeout(finish, 700);
                          }, 800);
                          return;
                        }
                        setTimeout(finish, 700);
                      });
                    }, 1000);
                  });
                }, 250);
              });
            });
          }
          return new Promise(function (resolve) {
            setTimeout(function () {
              var out;
              try {
                out = JSON.stringify({ groups: fbPublic(fbDiscover()) });
              } catch (e) {
                out = JSON.stringify({ groups: [] });
              }
              // popup не убиваем (см. menuScript) — просто возвращаем маску
              try {
                fbZonaMask();
              } catch (e2) {}
              resolve(out);
            }, 350);
          });
        }
      }
    }
    return JSON.stringify({ groups: [] });
  } catch (err) {
    return JSON.stringify({ groups: [] });
  }
})(${JSON.stringify(group)}, ${JSON.stringify(label)})`;

// очередь для menu/pick stage-ctl (см. player:stage-ctl): параллельные
// чтения меню и пики не должны работать с popup одновременно
let ctlChain: Promise<unknown> = Promise.resolve();

export function createRegistry(ipcMain: IpcMain, shell: Shell): void {
  registerStateStore(ipcMain);
  const parsers: SourceParser[] = [
    new KinogoParser(),
    new KinokongParser(),
    new LordfilmParser(),
    new ReYohohoParser(),
    new ReYoHoHoRuParser(),
    new ZonaParser(),
    new ZetflixParser(),
    new RutubeParser(),
    new LocalSourceParser(),
  ];
  const byId = new Map(parsers.map((p) => [p.id, p]));

  const requireParser = (id?: string): SourceParser => {
    const parser = (id && byId.get(id)) || parsers[0];
    if (!parser) throw new Error('Нет доступных источников');
    return parser;
  };

  /**
   * Кольцевой буфер последних ошибок источников — для вкладки
   * «Диагностика» в настройках: пользователь присылает скриншот,
   * и сразу видно, какой источник и с какой ошибкой упал.
   */
  const diagnostics: Array<{ t: number; sourceId: string; op: string; message: string }> = [];
  const recordDiag = (op: string, sourceId: string, err: unknown): void => {
    const message = String((err as Error)?.message ?? err).slice(0, 300);
    diagnostics.unshift({ t: Date.now(), sourceId, op, message });
    if (diagnostics.length > 60) diagnostics.length = 60;
  };

  ipcMain.handle('diagnostics:list', () =>
    diagnostics.map((d) => ({ ...d, name: byId.get(d.sourceId)?.name ?? d.sourceId })),
  );
  ipcMain.handle('diagnostics:clear', () => {
    diagnostics.length = 0;
  });

  ipcMain.handle('sources:list', (): SourceInfo[] =>
    parsers.map((p) => ({ id: p.id, name: p.name, categories: p.categories })),
  );

  ipcMain.handle('catalog:list', async (_e, req: CatalogRequest): Promise<PagedResult> => {
    const parser = requireParser(req.sourceId);
    try {
      return await parser.getCatalog(Math.max(1, req.page || 1), req.categoryId, req.filters);
    } catch (err) {
      recordDiag('Каталог', parser.id, err);
      throw err;
    }
  });

  ipcMain.handle('catalog:search', async (_e, req: SearchRequest): Promise<PagedResult> => {
    const parser = requireParser(req.sourceId);
    try {
      return await parser.search(req.query);
    } catch (err) {
      recordDiag('Поиск', parser.id, err);
      throw err;
    }
  });

  ipcMain.handle(
    'catalog:suggest',
    async (_e, req: { query: string; sourceIds?: string[] }): Promise<MediaSummary[]> => {
      const q = String(req?.query ?? '').trim();
      if (q.length < 2) return [];
      const ids = (req?.sourceIds ?? []).filter((id) => byId.has(id));
      const useIds = ids.length ? ids : parsers.map((p) => p.id);
      const settled = await Promise.allSettled(useIds.map((id) => requireParser(id).search(q)));
      const items: MediaSummary[] = [];
      const seenUrls = new Set<string>();
      const seenTitles = new Set<string>();
      for (const result of settled) {
        if (result.status !== 'fulfilled') continue;
        for (const item of result.value.items) {
          const titleKey = `${item.title.toLowerCase()}|${item.year ?? ''}`;
          if (seenUrls.has(item.url) || seenTitles.has(titleKey)) continue;
          seenUrls.add(item.url);
          seenTitles.add(titleKey);
          items.push(item);
          if (items.length >= 8) return items;
        }
      }
      return items;
    },
  );

  ipcMain.handle('media:details', async (_e, url: string): Promise<MediaDetails> => {
    const parser = parsers.find((p) => p.matchesUrl?.(url)) ?? requireParser();
    try {
      return await parser.getDetails(url);
    } catch (err) {
      recordDiag('Детали', parser.id, err);
      throw err;
    }
  });

  ipcMain.handle('media:streams', async (_e, req: StreamsRequest): Promise<StreamCatalog> => {
    const parser = requireParser(req.sourceId);
    const tab = req.tabUrl;
    if (!tab) throw new Error('Не указана ссылка на плеер');

    let referer: string | undefined;
    try {
      if (req.refererUrl) referer = new URL(req.refererUrl).origin + '/';
    } catch {
      referer = undefined;
    }
    if (referer) activeEmbedReferer = referer;

    if (/youtube|youtu\.be/i.test(tab)) {
      return {
        sourceId: parser.id,
        tabLabel: req.tabLabel ?? 'Видео',
        episodes: [],
        fallbackEmbedUrl: toYouTubeEmbed(tab) ?? tab,
      };
    }
    try {
      if (parser.resolveStreams) return await parser.resolveStreams(req, referer);
      return await resolveEmbed(tab, parser.id, req.tabLabel ?? 'Плеер', referer);
    } catch (err) {
      recordDiag('Плеер', parser.id, err);
      throw err;
    }
  });

  /**
   * Rezka plays only through its own media page, which the stage embeds
   * as-is. The renderer polls this to learn where the player box sits on
   * that page; the frame is scrolled to it (sticky page chrome is dropped)
   * so the stage can crop down to the player instead of showing the site.
   */
  ipcMain.handle('player:frame-rect', async (e, req: unknown): Promise<FrameRect | null> => {
    const { url, stageW, stageH } = (req ?? {}) as {
      url?: unknown;
      stageW?: unknown;
      stageH?: unknown;
    };
    if (typeof url !== 'string' || !url || !Number.isFinite(stageW) || !Number.isFinite(stageH)) {
      return null;
    }
    const base = url.split('#')[0];
    const root = e.senderFrame ?? e.sender.mainFrame;
    const frame = (root?.framesInSubtree ?? []).find((f) => (f.url || '').split('#')[0] === base);
    if (!frame) return null;
    const script = `(function (stageW, stageH) {
        const root = document.getElementById('watch') || document.querySelector('.watch-section');
        if (!root) return JSON.stringify({ state: 'no-root' });
        if (document.querySelector('.kg-check-overlay')) return JSON.stringify({ state: 'gate' });
        // sticky/fixed page chrome would hang over the cropped player
        for (const el of document.querySelectorAll('body *')) {
          if (root.contains(el) || el.closest('.kg-check-overlay')) continue;
          const cs = getComputedStyle(el);
          if ((cs.position === 'sticky' || cs.position === 'fixed') && cs.display !== 'none') {
            el.style.setProperty('display', 'none', 'important');
          }
        }
        // the crop owns the panning — keep the page itself from scrolling
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        let target = null;
        let best = 0;
        for (const el of root.querySelectorAll('iframe, video')) {
          const r = el.getBoundingClientRect();
          const area = r.width * r.height;
          if (area > best) { best = area; target = el; }
        }
        if (!target) target = root;
        const r = target.getBoundingClientRect();
        if (r.width < 64 || r.height < 64) return JSON.stringify({ state: 'too-small' });
        const x = r.left + window.scrollX;
        const y = r.top + window.scrollY;
        const height = Math.min(stageH, r.height);
        const leftPad = Math.max(0, (stageW - r.width) / 2);
        const topPad = Math.max(0, (stageH - height) / 2);
        window.scrollTo({ left: Math.max(0, x - leftPad), top: y, behavior: 'instant' });
        return JSON.stringify({
          state: 'ok',
          x, y, w: r.width, h: r.height,
          sx: window.scrollX, sy: window.scrollY,
          height, leftPad, topPad,
        });
      })(${Number(stageW)}, ${Number(stageH)})`;
    try {
      const result = await Promise.race([
        frame.executeJavaScript(script, true),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      return typeof result === 'string' ? (JSON.parse(result) as FrameRect) : null;
    } catch {
      return null; // frame navigated away mid-measure — caller retries
    }
  });

  /**
   * The stage iframe is cross-origin — the renderer cannot reach its <video>.
   * The main process runs the transport for it: pushes volume/mute into the
   * frame that owns the main video, hides the embed's own control bars (our
   * transport replaces them), toggles or seeks playback, and reports the
   * state back for the app's transport bar. Re-applied periodically while the
   * stage is open — the player may (re)create its media element («Смотреть»,
   * next episode) at any moment.
   */
  ipcMain.handle('player:stage-ctl', async (e, req: unknown): Promise<StageCtlResult | null> => {
    const { action, volume, muted, time, group, label, series } = (req ?? {}) as {
      action?: unknown;
      volume?: unknown;
      muted?: unknown;
      time?: unknown;
      group?: unknown;
      label?: unknown;
      series?: unknown;
    };
    const root = e.senderFrame ?? e.sender.mainFrame;
    // child frames only: the app's own document has no stage media, and the
    // broad hide-controls selectors must never touch our UI
    const frames = (root?.framesInSubtree ?? []).filter((f) => f !== root);

    const run = async (frame: WebFrameMain, script: string): Promise<unknown> =>
      Promise.race([
        frame.executeJavaScript(script, true),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);

    const vol =
      typeof volume === 'number' && Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : -1;
    const seekAt = typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : 0;
    const isSeries = series === true;
    const menuGroup = typeof group === 'string' ? group : '';
    const menuItem = typeof label === 'string' ? label : '';

    // menu/pick — чтение и переключение меню embed-плеера (остров контролов);
    // state/toggle/seek идут ниже, к фрейму с крупнейшим <video>
    if (action === 'menu' || action === 'pick') {
      // поллинг меню (каждые 3с) и пик конкурируют за popup: fbZonaClose из
      // параллельного menu-чтения убивал popup посреди танца выбора качества
      // (и мешал открытию popup при пике сезона) — выполняем строго по очереди
      const prevCtl = ctlChain;
      let releaseCtl: () => void = () => {};
      ctlChain = new Promise<void>((r) => (releaseCtl = r));
      await prevCtl;
      try {
        const script = action === 'menu' ? menuScript : pickScript(menuGroup, menuItem);
        const scanned = await Promise.all(
          frames.map(async (frame) => {
            try {
              const raw = await run(frame, script);
              if (typeof raw !== 'string') return null;
              const parsed = JSON.parse(raw) as { groups?: EmbedMenuGroup[] };
              return Array.isArray(parsed.groups) ? parsed.groups : null;
            } catch {
              return null;
            }
          }),
        );
        let groups: EmbedMenuGroup[] = [];
        for (const item of scanned) if (item && item.length > groups.length) groups = item;
        // клик не нашёл пункта — держим прежнее меню, не затирая его пустым
        if (action === 'pick' && !groups.length) return null;
        return { groups };
      } finally {
        releaseCtl();
      }
    }

    // one script per frame: hides the site's bars, finds the biggest visible
    // <video> (ads/previews are smaller), applies volume to it, and either
    // reports the state or toggles/seeks — the action runs only on the frame
    // that owns the largest video (chosen below)
    const ctlScript = (mode: 'state' | 'toggle' | 'seek'): string =>
      `(function (mode, t, vol, muted, series) {
        try {
          if (!document.getElementById('fb-hide-ctl')) {
            var s = document.createElement('style');
            s.id = 'fb-hide-ctl';
            s.textContent =
              'video::-webkit-media-controls{display:none!important}' +
              'video::-webkit-media-controls-enclosure{display:none!important}' +
              'video::-webkit-media-controls-overlay-play-button{display:none!important}' +
              '[class*="control" i]:not(:has(video)):not(:has(audio)),' +
              '[id*="control" i]:not(:has(video)):not(:has(audio)),' +
              '[class*="trailer" i]:not(:has(video)):not(:has(iframe)),' +
              '.btn.trailer,' +
              '.fp-ui,.ytp-chrome-bottom,.ytp-gradient-bottom,.ytp-pause-overlay' +
              '{display:none!important}';
            (document.head || document.documentElement).appendChild(s);
          }
          // скроллбары embed-страниц не нужны — в стейдже виден только плеер
          if (!document.getElementById('fb-noscroll')) {
            var ns = document.createElement('style');
            ns.id = 'fb-noscroll';
            ns.textContent =
              '*::-webkit-scrollbar{width:0!important;height:0!important}' +
              '*{scrollbar-width:none!important}';
            (document.head || document.documentElement).appendChild(ns);
          }
          // zona/video.js: скин удерживает панель через !important — прячем её
          // инлайном (маска окна настроек — в fbZonaOpen, при чтении меню)
          if (document.querySelector('.vjs-quality-button, .vjs-settings-popup')) {
            var vcb = document.querySelector('.vjs-control-bar');
            if (vcb && vcb.style.getPropertyValue('display') !== 'none') {
              vcb.style.setProperty('display', 'none', 'important');
            }
          }
          // элементы, вынесенные в остров контролов (сезон/серия из нашего
          // плейлиста) — прячем только когда плейлист действительно есть
          var dyn = document.getElementById('fb-hide-dyn');
          if (!dyn) {
            dyn = document.createElement('style');
            dyn.id = 'fb-hide-dyn';
            (document.head || document.documentElement).appendChild(dyn);
          }
          dyn.textContent = series
            ? '[class*="episode" i]:not(:has(video)):not(:has(iframe)),' +
              '[class*="season" i]:not(:has(video)):not(:has(iframe))' +
              '{display:none!important}'
            : '';
          // fullscreen auto-hide: report pointer activity inside this document
          // up to the app (events over an iframe never reach the parent window)
          if (!window.__fbMm) {
            window.__fbMm = 1;
            var lastMm = 0;
            document.addEventListener('mousemove', function (ev) {
              // плееры дёргают синтетический mousemove для своих таймеров —
              // только настоящее движение указателя должно будить контролы
              if (!ev.isTrusted) return;
              var now = Date.now();
              if (now - lastMm < 140) return;
              lastMm = now;
              try { parent.postMessage({ fb: 'mm' }, '*'); } catch (e) {}
            }, true);
            window.addEventListener('message', function (ev) {
              if (ev.data && ev.data.fb === 'mm') {
                try { parent.postMessage(ev.data, '*'); } catch (e) {}
              }
            });
          }
          var list = document.querySelectorAll('video');
          var best = null, bestArea = 0;
          for (var i = 0; i < list.length; i++) {
            var r = list[i].getBoundingClientRect();
            var area = r.width * r.height;
            if (!(area > 0)) area = (list[i].videoWidth || 0) * (list[i].videoHeight || 0);
            if (!best || area > bestArea) { best = list[i]; bestArea = area; }
          }
          if (!best) return JSON.stringify({ found: false });
          if (vol >= 0) {
            try { best.volume = vol; best.muted = !!muted; } catch (e) {}
            var auds = document.querySelectorAll('audio');
            for (var j = 0; j < auds.length; j++) {
              try { auds[j].volume = vol; auds[j].muted = !!muted; } catch (e) {}
            }
          }
          var pack = function () {
            var d = isFinite(best.duration) && best.duration > 0 ? best.duration : 0;
            // конец буфера — полоска показывает подгруженный кусок
            var buf = 0;
            try {
              var br = best.buffered;
              var ct = best.currentTime || 0;
              for (var k = 0; k < br.length; k++) {
                if (br.start(k) <= ct && ct <= br.end(k)) { buf = br.end(k); break; }
                if (br.start(k) <= ct && br.end(k) > buf) buf = br.end(k);
              }
            } catch (e) {}
            return JSON.stringify({
              found: true, paused: !!best.paused, t: best.currentTime || 0,
              d: d, b: buf, area: Math.round(bestArea),
            });
          };
          if (mode === 'seek') {
            try { best.currentTime = t; } catch (e) {}
            return pack();
          }
          if (mode === 'toggle') {
            // players like stravers/allplay attach media only through their own
            // control buttons — a bare video.play() "succeeds" but never starts
            // the stream, so click the player's control first, then reconcile
            var wantPlay = best.paused;
            var sels = wantPlay
              ? '[aria-label*="Воспроизвести" i],[title*="Воспроизвести" i],' +
                '[aria-label^="Play" i],[title^="Play" i],' +
                '.vjs-big-play-button,[class*="big-play" i],[class*="bigplay" i],' +
                '[class*="play-button" i],[class*="playbtn" i],.fp-play-button,' +
                '.jw-overlay-play-button,.jw-icon-play,.jw-display-icon-play,' +
                '[class*="btn-play" i]'
              : '[aria-label*="Пауза" i],[title*="Пауза" i],' +
                '[aria-label^="Pause" i],[title^="Pause" i],' +
                '[class*="pause-button" i],[class*="pausebtn" i],' +
                '[class*="btn-pause" i],.jw-icon-pause';
            var clickCtl = function () {
              try {
                var b = document.querySelector(sels);
                if (b) { b.click(); return true; }
              } catch (e) {}
              return false;
            };
            var hit = clickCtl();
            if (!wantPlay) {
              return new Promise(function (resolve) {
                setTimeout(function () {
                  if (!best.paused) { try { best.pause(); } catch (e) {} }
                  setTimeout(function () { resolve(pack()); }, 300);
                }, hit ? 700 : 50);
              });
            }
            // play: give the player's own handler time to attach the stream,
            // retry its button once, and only then fall back to video.play()
            return new Promise(function (resolve) {
              setTimeout(function () {
                if (best.paused) {
                  clickCtl();
                  setTimeout(function () {
                    if (best.paused) { try { best.play(); } catch (e) {} }
                    setTimeout(function () { resolve(pack()); }, 300);
                  }, 500);
                } else {
                  resolve(pack());
                }
              }, hit ? 900 : 300);
            });
          }
          return pack();
        } catch (err) {
          return JSON.stringify({ found: false });
        }
      })('${mode}', ${seekAt}, ${vol}, ${muted ? 'true' : 'false'}, ${isSeries ? 'true' : 'false'})`;

    const parse = (raw: unknown): (StageState & { area: number }) | null => {
      if (typeof raw !== 'string') return null;
      try {
        const parsed = JSON.parse(raw) as {
          found?: boolean;
          paused?: boolean;
          t?: number;
          d?: number;
          b?: number;
          area?: number;
        };
        if (!parsed.found) return null;
        return {
          paused: !!parsed.paused,
          t: parsed.t ?? 0,
          d: parsed.d ?? 0,
          b: parsed.b ?? 0,
          area: parsed.area ?? 0,
        };
      } catch {
        return null;
      }
    };

    // phase 1: volume + hidden bars + state from every frame, in parallel
    const results = await Promise.all(
      frames.map(async (frame) => {
        try {
          return { frame, st: parse(await run(frame, ctlScript('state'))) };
        } catch {
          // frame navigated away mid-call — the next tick covers its replacement
          return null;
        }
      }),
    );
    let best: { frame: WebFrameMain; st: StageState & { area: number } } | null = null;
    for (const item of results) {
      if (item?.st && (!best || item.st.area > best.st.area)) {
        best = { frame: item.frame, st: item.st };
      }
    }
    if (!best) return null;

    // phase 2: act on the frame that owns the main video, read the fresh state
    if (action === 'toggle' || action === 'seek') {
      try {
        const fresh = parse(await run(best.frame, ctlScript(action)));
        if (fresh) return fresh;
      } catch {
        // frame went away mid-call — keep the phase-1 state
      }
    }
    return best.st;
  });

  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('app:version', (): string => app.getVersion());
}
