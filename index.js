// ============================================================
// 预设分组管家 (st-preset-organizer) v1.0.0
// 功能：自动检测预设适配模型 → 分组；自定义标签；常用预设区；同名版本折叠
// ============================================================
import { openai_settings, openai_setting_names, oai_settings } from '../../../../scripts/openai.js';
import { getContext } from '../../../st-context.js';

const context = getContext();
const eventSource = context.eventSource;
const eventTypes = context.eventTypes;

const SETTINGS_KEY = 'st_preset_organizer';

// ---------------- 模型检测引擎 ----------------

// 文件名关键词（权重最高，作者直接标注）
// 名字规则：只有明确出现模型标记才算（kemini=Gemini、klaude/克劳德/克洛德=Claude、ds/dsvN/ds预设=DeepSeek）
const NAME_RULES = [
    { cat: 'claude', re: /claude|klaude|克劳德|克洛德/i },
    { cat: 'gemini', re: /gemini|kemini/i },
    { cat: 'deepseek', re: /deepseek|deep ?seek|\bds\b|dsv?\d|ds预设/i },
    { cat: 'openai', re: /gpt[-_\d]|openai|chatgpt/i },
];

// 内容全文关键词（作者话里常写明适配模型；命中只作弱信号 +2）
const CONTENT_PATTERNS = [
    { cat: 'claude', re: /claude|klaude|anthropic|\b(sonnet|opus|haiku)\b|克劳德/i },
    { cat: 'gemini', re: /gemini|kemini/i },
    { cat: 'deepseek', re: /deepseek|deep ?seek|深度求索/i },
    { cat: 'openai', re: /gpt-?\d|openai|chatgpt|o[134]-?(mini|pro)/i },
];

// 检测引擎版本：升级检测逻辑时 +1，触发一次全量重扫迁移
const DETECT_VERSION = 2;

// 主类别顺序（渲染顺序）
const CATEGORY_ORDER = ['claude', 'gemini', 'deepseek', 'claude_gemini', 'openai', 'multi', 'unknown'];

const CATEGORY_LABEL = {
    claude: 'Claude',
    gemini: 'Gemini',
    deepseek: 'DeepSeek',
    claude_gemini: 'Claude+Gemini 皆可',
    openai: 'OpenAI 系',
    multi: '多模型通用',
    unknown: '未识别/通用',
};

const CATEGORY_COLOR = {
    claude: '#d97757',
    gemini: '#4f8ef7',
    deepseek: '#4d6bfe',
    claude_gemini: '#b48aea',
    openai: '#10a37f',
    multi: '#8a919e',
    unknown: '#6b7280',
};

function collectText(preset) {
    // 收集预设内所有文本信号：优先 prompts 数组（1.19+ 内容主体），再补各文本字段
    const parts = [];
    const pushStr = (v) => {
        if (typeof v === 'string' && v) parts.push(v);
    };
    const prompts = preset.prompts;
    if (Array.isArray(prompts)) {
        for (const pm of prompts) {
            if (pm && typeof pm === 'object' && pm.enabled !== false) {
                const c = pm.content || pm.prompt || pm.text || '';
                pushStr(String(c));
            }
        }
    }
    pushStr(preset.prompt);
    pushStr(preset.jailbreak);
    pushStr(preset.system_prompt);
    pushStr(preset.impersonation_prompt);
    pushStr(preset.assistant_prefill);
    pushStr(preset.continue_prefill);
    pushStr(preset.nsfw_prompt);
    pushStr(preset.post_history_instructions);
    pushStr(preset.main_prompt);
    pushStr(preset.new_chat_prompt);
    pushStr(preset.extensions?.prompt);
    pushStr(preset.extensions?.jailbreak);
    return parts.join('\n');
}

function detectModelFit(name, preset) {
    const nameLower = name.toLowerCase();
    const source = String(preset.chat_completion_source || '').toLowerCase();
    const text = collectText(preset);

    const hits = { claude: 0, gemini: 0, deepseek: 0, openai: 0 };

    // 1) 文件名：明确出现模型标记才 +3（kemini=Gemini、klaude/克劳德=Claude）
    for (const rule of NAME_RULES) {
        if (rule.re.test(nameLower)) hits[rule.cat] += 3;
    }

    // 2) chat_completion_source +2
    if (source === 'claude') hits.claude += 2;
    else if (source === 'openai') hits.openai += 2;
    // source=custom 不做直接加分，看 custom_model（用户真实配置）

    // 3) custom_model（source=custom 时的真实模型配置，+3；排除默认占位）
    const cm = String(preset.custom_model || '').toLowerCase().trim();
    if (source === 'custom' && cm && cm !== 'gpt-4-turbo') {
        for (const rule of NAME_RULES) {
            if (rule.re.test(cm)) { hits[rule.cat] += 3; break; }
        }
    }

    // 4) prompts 全文 + 各文本字段：模型关键词弱信号 +2（封顶 2，防长文刷分）
    if (text) {
        for (const rule of CONTENT_PATTERNS) {
            const m = text.match(rule.re);
            if (m) hits[rule.cat] += Math.min(m.length, 2);
        }
    }

    // 决策：先强信号（>=3），再弱信号（>=1）
    const strong = Object.entries(hits).filter(([, v]) => v >= 3).map(([k]) => k);
    const weak = Object.entries(hits).filter(([, v]) => v >= 1).map(([k]) => k);

    let category;
    if (strong.length >= 3) category = 'multi';
    else if (strong.length === 2 && strong.includes('claude') && strong.includes('gemini')) category = 'claude_gemini';
    else if (strong.length === 2) category = 'multi';
    else if (strong.length === 1) category = strong[0];
    else if (weak.length >= 3) category = 'multi';
    else if (weak.length === 2 && weak.includes('claude') && weak.includes('gemini')) category = 'claude_gemini';
    else if (weak.length === 2) category = 'multi';
    else if (weak.length === 1) category = weak[0];
    else category = 'unknown';

    return { category, label: CATEGORY_LABEL[category], color: CATEGORY_COLOR[category], hits };
}

// ---------------- 版本拆分 ----------------

function splitVersion(name) {
    let n = name.replace(/\.json$/i, '');
    const versionBits = [];

    // 尾部副本标记 (1)/(2)/（3）
    n = n.replace(/(\s*[（(]\s*\d+\s*[)）])+$/g, (m) => { versionBits.push(m.trim()); return ''; });

    // ✦/✧ 版本标记
    n = n.replace(/[✦✧]\s*[\dv.]+/g, (m) => { versionBits.push(m.trim()); return ''; });

    // [模型标记]（不参与 base，参与折叠判断靠 category）
    n = n.replace(/\[[^\]]*\]/g, '');

    // vX.Y / X.Y.Z 版本段（词边界，避免拆坏核心名里的数字）
    n = n.replace(/(^|[\s\-_.~])(v?\d+(?:\.\d+){1,2})(?=$|[\s\-_.~])/gi, (m, p, v) => { versionBits.push(v); return p; });

    // 头部 -N.N- 或尾部 -N.N（如 -5.56-小狗之神、Miracle-1.82）
    n = n.replace(/^-?[\d.]+-/g, (m) => { versionBits.push(m.replace(/-/g, '').trim()); return ''; });
    n = n.replace(/-[\d.]+$/g, (m) => { versionBits.push(m.replace(/-/g, '').trim()); return ''; });

    // 尾部日期/代号括号注释（0306）之类
    n = n.replace(/[（(][^)）]*[)）]$/g, (m) => { versionBits.push(m.trim()); return ''; });

    return { base: n.replace(/\s+/g, ' ').trim(), version: versionBits.join(' ') };
}

// ---------------- 状态持久化 ----------------

function loadState() {
    if (!context.extensionSettings[SETTINGS_KEY]) {
        context.extensionSettings[SETTINGS_KEY] = {};
    }
    return context.extensionSettings[SETTINGS_KEY];
}

function saveState() {
    context.saveSettingsDebounced();
}

function getTags() { return loadState().tags || {}; }
function getFavorites() { return loadState().favorites || []; }
function getCollapsedCats() { return loadState().collapsedCats || {}; }
function getCollapsedBases() { return loadState().collapsedBases || {}; }

// ---------------- UI ----------------

let panelVisible = false;
let scanCache = []; // {name, index, category, label, color, base, version, tag, current}

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scanPresets() {
    // 增量扫描：已分类的预设直接用缓存，只检测新出现的预设
    const st = loadState();
    st.categories = st.categories || {};
    // 检测引擎升级 → 清缓存全量重扫一次（一次性迁移）
    if (st.detectVer !== DETECT_VERSION) {
        st.categories = {};
        st.detectVer = DETECT_VERSION;
    }
    let newCount = 0;
    const knownNames = new Set();
    scanCache = [];
    for (const [name, index] of Object.entries(openai_setting_names || {})) {
        const preset = openai_settings[index];
        if (!preset) continue;
        knownNames.add(name);
        let category = st.categories[name];
        if (!category) {
            category = detectModelFit(name, preset).category;
            st.categories[name] = category;
            newCount++;
        }
        const { base, version } = splitVersion(name);
        const tags = getTags();
        scanCache.push({
            name,
            index,
            category,
            label: CATEGORY_LABEL[category],
            color: CATEGORY_COLOR[category],
            base,
            version,
            tag: tags[name] || '',
            current: oai_settings?.preset_settings_openai === name,
        });
    }
    // 清理已删除预设的缓存
    let removed = false;
    for (const key of Object.keys(st.categories)) {
        if (!knownNames.has(key)) { delete st.categories[key]; removed = true; }
    }
    if (newCount > 0 || removed) saveState();
    // 排序：先按类别顺序，再按名称
    scanCache.sort((a, b) => {
        const ca = CATEGORY_ORDER.indexOf(a.category);
        const cb = CATEGORY_ORDER.indexOf(b.category);
        if (ca !== cb) return ca - cb;
        return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
}

// 调试钩子
window.stpoDebug = {
    get namesCount() { return Object.keys(openai_setting_names || {}).length; },
    get presetsLen() { return (openai_settings || []).length; },
    get cacheLen() { return scanCache.length; },
    get cache() { return scanCache; },
    scan() { try { scanPresets(); return 'scan ok: ' + scanCache.length; } catch (e) { return 'scan fail: ' + e.message; } },
    render() { try { render(); return 'render ok'; } catch (e) { return 'render fail: ' + e.message; } },
};

function applyPreset(index, name) {
    try {
        const $sel = $('#settings_preset_openai');
        if ($sel.length && index !== undefined && index !== null) {
            $sel.val(index).trigger('change');
        }
        window.toastr?.success?.(`已加载预设：${name}`);
        scanPresets();
        render();
    } catch (e) {
        window.toastr?.error?.('加载失败：' + e.message);
        console.error('[stpo] applyPreset error', e);
    }
}

function toggleFav(name) {
    const favs = getFavorites();
    const idx = favs.indexOf(name);
    if (idx >= 0) favs.splice(idx, 1);
    else favs.push(name);
    const st = loadState();
    st.favorites = favs;
    saveState();
    render();
}

function moveFav(name, dir) {
    const favs = getFavorites();
    const idx = favs.indexOf(name);
    const target = idx + dir;
    if (idx < 0 || target < 0 || target >= favs.length) return;
    [favs[idx], favs[target]] = [favs[target], favs[idx]];
    const st = loadState();
    st.favorites = favs;
    saveState();
    render();
}

function toggleCollapsedCat(cat) {
    const st = loadState();
    const c = st.collapsedCats || {};
    c[cat] = !c[cat];
    st.collapsedCats = c;
    saveState();
    render();
}

function toggleCollapsedBase(base) {
    const st = loadState();
    const b = st.collapsedBases || {};
    b[base] = !b[base];
    st.collapsedBases = b;
    saveState();
    render();
}

function startTagEdit(name, li, isFav = false) {
    const current = getTags()[name] || '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'stpo-tag-input';
    input.value = current;
    input.placeholder = '自定义标签，回车保存';
    li.querySelector('.stpo-item-main')?.appendChild(input);
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const st = loadState();
            st.tags = st.tags || {};
            const v = input.value.trim();
            if (v) st.tags[name] = v;
            else delete st.tags[name];
            saveState();
            scanPresets();
            render();
        } else if (e.key === 'Escape') {
            render();
        }
        e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
}

function buildFavRow(name) {
    const li = document.createElement('li');
    li.className = 'stpo-item stpo-fav-item';
    const main = document.createElement('div');
    main.className = 'stpo-item-main';
    main.innerHTML = `<span class="stpo-star">★</span><span class="stpo-name">${escHtml(name)}</span>`;
    main.addEventListener('click', () => {
        const index = openai_setting_names?.[name];
        if (index !== undefined) applyPreset(index, name);
    });
    const ops = document.createElement('div');
    ops.className = 'stpo-item-ops';
    const mkBtn = (cls, title, fn) => {
        const b = document.createElement('button');
        b.className = 'stpo-btn ' + cls;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
    };
    ops.appendChild(mkBtn('stpo-btn-up', '上移', () => moveFav(name, -1)));
    ops.appendChild(mkBtn('stpo-btn-down', '下移', () => moveFav(name, 1)));
    ops.appendChild(mkBtn('stpo-btn-tag', '编辑标签', () => startTagEdit(name, li)));
    ops.appendChild(mkBtn('stpo-btn-star-off', '移出常用', () => toggleFav(name)));
    li.appendChild(main);
    li.appendChild(ops);
    return li;
}

function showCategorySelect(item, li) {
    const main = li.querySelector('.stpo-item-main');
    if (!main) return;
    const badge = main.querySelector('.stpo-badge');
    const sel = document.createElement('select');
    sel.className = 'stpo-cat-select';
    for (const cat of CATEGORY_ORDER) {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = CATEGORY_LABEL[cat];
        if (cat === item.category) opt.selected = true;
        sel.appendChild(opt);
    }
    if (badge) badge.replaceWith(sel);
    else main.insertBefore(sel, main.firstChild);
    sel.focus();
    sel.addEventListener('click', (e) => e.stopPropagation());
    sel.addEventListener('change', () => {
        const st = loadState();
        st.categories = st.categories || {};
        st.categories[item.name] = sel.value;
        saveState();
        scanPresets();
        render();
    });
}

function buildPresetRow(item) {
    const li = document.createElement('li');
    li.className = 'stpo-item' + (item.current ? ' stpo-current' : '');

    const main = document.createElement('div');
    main.className = 'stpo-item-main';
    const badge = `<span class="stpo-badge stpo-badge-edit" data-cat="${item.category}" title="点击修改分类">${escHtml(item.label)}</span>`;
    const tagHtml = item.tag
        ? `<span class="stpo-tag" title="自定义标签">${escHtml(item.tag)}</span>`
        : '';
    main.innerHTML = `${badge}<span class="stpo-name">${escHtml(item.name)}</span>${tagHtml}`;
    main.addEventListener('click', (e) => {
        if (e.target.classList?.contains('stpo-badge-edit')) {
            showCategorySelect(item, li);
            return;
        }
        applyPreset(item.index, item.name);
    });

    const ops = document.createElement('div');
    ops.className = 'stpo-item-ops';
    const mkBtn = (cls, title, fn) => {
        const b = document.createElement('button');
        b.className = 'stpo-btn ' + cls;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
    };
    const inFav = getFavorites().includes(item.name);
    ops.appendChild(mkBtn(inFav ? 'stpo-btn-star-on' : 'stpo-btn-star', inFav ? '移出常用' : '加入常用', () => toggleFav(item.name)));
    ops.appendChild(mkBtn('stpo-btn-tag', '编辑标签', () => startTagEdit(item.name, li)));
    li.appendChild(main);
    li.appendChild(ops);
    return li;
}

function buildGroup(cat) {
    const items = scanCache.filter((x) => x.category === cat);
    if (items.length === 0) return null;

    const wrap = document.createElement('div');
    wrap.className = 'stpo-group';

    const header = document.createElement('div');
    header.className = 'stpo-group-header';
    const collapsed = getCollapsedCats()[cat];
    header.innerHTML = `<span class="stpo-caret">${collapsed ? '▸' : '▾'}</span><span class="stpo-dot" style="background:${CATEGORY_COLOR[cat]}"></span><span class="stpo-group-name">${CATEGORY_LABEL[cat]}</span><span class="stpo-count">${items.length}</span>`;
    header.addEventListener('click', () => toggleCollapsedCat(cat));
    wrap.appendChild(header);

    if (collapsed) return wrap;

    const list = document.createElement('ul');
    list.className = 'stpo-list';

    // 相同 base + 相同 category 的多个 → 版本折叠组
    const grouped = new Map();
    for (const item of items) {
        if (!item.base) { grouped.set('__single__' + item.name, item); continue; }
        const key = item.base + '\u0000' + item.category;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
    }

    for (const [key, val] of grouped) {
        const arr = Array.isArray(val) ? val : [val];
        if (Array.isArray(val) && val.length > 1) {
            // 版本折叠组（默认折叠）
            const baseCollapsed = getCollapsedBases()[key] !== false; // 默认折叠
            const li = document.createElement('li');
            li.className = 'stpo-item stpo-base-item';
            const head = document.createElement('div');
            head.className = 'stpo-base-head';
            head.innerHTML = `<span class="stpo-caret">${baseCollapsed ? '▸' : '▾'}</span><span class="stpo-base-name">${escHtml(val[0].base)}</span><span class="stpo-count">${val.length} 个版本</span>`;
            head.addEventListener('click', () => toggleCollapsedBase(key));
            li.appendChild(head);
            if (!baseCollapsed) {
                const sub = document.createElement('ul');
                sub.className = 'stpo-list stpo-sub';
                arr.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')).forEach((it) => sub.appendChild(buildPresetRow(it)));
                li.appendChild(sub);
            }
            list.appendChild(li);
        } else {
            list.appendChild(buildPresetRow(arr[0]));
        }
    }

    wrap.appendChild(list);
    return wrap;
}

function render() {
    const $panel = $('#stpo-panel');
    if ($panel.length === 0) return;
    const query = ($('#stpo-search').val() || '').trim().toLowerCase();

    // 常用区
    const $favList = $('#stpo-fav-list');
    $favList.empty();
    const favs = getFavorites().filter((n) => openai_setting_names?.[n] !== undefined);
    if (favs.length === 0) {
        $favList.append('<div class="stpo-empty">还没有常用预设，点条目右侧 ★ 加入</div>');
    } else {
        favs.forEach((n) => $favList.append(buildFavRow(n)));
    }

    // 分组区
    const $groups = $('#stpo-groups');
    $groups.empty();
    const filtered = query ? scanCache.filter((x) => x.name.toLowerCase().includes(query)) : scanCache;
    if (filtered.length === 0) {
        $groups.append('<div class="stpo-empty">没有匹配的预设</div>');
    } else {
        // 搜索时临时只看过滤结果
        const savedCache = scanCache;
        scanCache = filtered;
        for (const cat of CATEGORY_ORDER) {
            const g = buildGroup(cat);
            if (g) $groups.append(g);
        }
        scanCache = savedCache;
    }
}

function initPanel() {
    if ($('#stpo-panel').length) return;
    const panel = document.createElement('div');
    panel.id = 'stpo-panel';
    panel.innerHTML = `
        <div class="stpo-header">
            <span class="stpo-title">预设分组管家</span>
            <input id="stpo-search" type="text" placeholder="搜索预设…" />
            <button id="stpo-refresh" class="stpo-btn stpo-btn-ghost" title="重新扫描">↻</button>
            <button id="stpo-close" class="stpo-btn stpo-btn-ghost" title="关闭">✕</button>
        </div>
        <div class="stpo-fav">
            <div class="stpo-fav-title">★ 常用预设 <span class="stpo-hint">（点击即加载）</span></div>
            <ul id="stpo-fav-list" class="stpo-list"></ul>
        </div>
        <div class="stpo-fav-sep"></div>
        <div class="stpo-groups-wrap">
            <div id="stpo-groups"></div>
            <div class="stpo-foot">检测依据：预设名 / 模型来源 / 模型字段 / 提示词内容，仅供参考</div>
        </div>
    `;
    document.body.appendChild(panel);

    $('#stpo-close').on('click', () => { panelVisible = false; $('#stpo-panel').removeClass('stpo-show'); });
    $('#stpo-refresh').on('click', () => { scanPresets(); render(); });
    $('#stpo-search').on('input', render);
    $(document).on('click', (e) => {
        if (panelVisible && !$(e.target).closest('#stpo-panel').length && !$(e.target).closest('#stpo-toggle').length) {
            panelVisible = false;
            $('#stpo-panel').removeClass('stpo-show');
        }
    });
}

function addToggleButton() {
    if ($('#stpo-toggle').length) return;
    const $container = $('#settings_preset_openai').parent().find('.flex-container').first();
    const host = $container.length ? $container : $('#settings_preset_openai').parent();
    const btn = document.createElement('div');
    btn.id = 'stpo-toggle';
    btn.className = 'menu_button menu_button_icon stpo-toggle-btn';
    btn.title = '预设分组管家';
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
        <path d="M12 21.5 C6.2 17.6 4.2 11.6 6.4 7.4 C8 4.4 12 4.6 12 4.6 C12 4.6 16 4.4 17.6 7.4 C19.8 11.6 17.8 17.6 12 21.5 Z" fill="#8fa3b8"/>
        <path d="M12 21.5 C9.5 19.8 8.2 17 8.2 13.8 C8.2 11.2 9.6 9 11.6 7.6 C13.6 9 15 11.2 15 13.8 C15 17 14.5 19.8 12 21.5 Z" fill="#a9bbcc" opacity="0.85"/>
        <circle cx="9.2" cy="12.4" r="0.75" fill="#eef3f8"/>
        <circle cx="12.6" cy="10.6" r="0.75" fill="#eef3f8"/>
        <circle cx="10.6" cy="15.6" r="0.75" fill="#eef3f8"/>
        <circle cx="14" cy="13.4" r="0.75" fill="#eef3f8"/>
        <circle cx="8" cy="15.2" r="0.7" fill="#eef3f8"/>
        <circle cx="14.6" cy="16.4" r="0.7" fill="#eef3f8"/>
        <path d="M12 4.6 C10.6 2.4 7.6 2 6.6 3.2 C9 3.2 11 3.9 12 4.6 Z" fill="#9db39a"/>
        <path d="M12 4.6 C13.4 2.4 16.4 2 17.4 3.2 C15 3.2 13 3.9 12 4.6 Z" fill="#9db39a"/>
        <path d="M12 4.2 C11.6 2.8 11 1.8 10 1.4 C11.6 1.6 11.8 2.6 12 4.2 Z" fill="#aac0a7"/>
    </svg>`;
    btn.addEventListener('click', () => {
        panelVisible = !panelVisible;
        $('#stpo-panel').toggleClass('stpo-show', panelVisible);
        if (panelVisible) { scanPresets(); render(); }
    });
    host.append(btn);
}

function init() {
    if (typeof openai_settings === 'undefined' || !openai_setting_names) {
        setTimeout(init, 1000);
        return;
    }
    // 防御：清除页面中任何残留的旧版面板/按钮（防止旧代码与新代码同时加载造成双面板）
    document.querySelectorAll('#stpo-panel, #stpo-toggle').forEach((e) => e.remove());
    initPanel();
    addToggleButton();
}

// 等酒馆设置加载完成
eventSource.on(eventTypes.APP_READY, init);
setTimeout(init, 3000); // 兜底
