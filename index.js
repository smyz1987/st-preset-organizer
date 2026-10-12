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
const DETECT_VERSION = 4;

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
    // 收集预设内所有文本信号：prompts 数组（含 disabled 条目——作者话/校准条目常写明适配模型）+ 各文本字段
    const parts = [];
    const pushStr = (v) => {
        if (typeof v === 'string' && v) parts.push(v);
    };
    const prompts = preset.prompts;
    if (Array.isArray(prompts)) {
        for (const pm of prompts) {
            if (pm && typeof pm === 'object') {
                // 不跳过 disabled：禁用条目（如 Calibration 校准、作者说明）同样暴露模型取向
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
    pushStr(preset.description);
    pushStr(preset.extensions?.prompt);
    pushStr(preset.extensions?.jailbreak);
    return parts.join('\n');
}

function detectModelFit(name, preset) {
    const nameLower = name.toLowerCase();
    const source = String(preset.chat_completion_source || '').toLowerCase();
    const text = collectText(preset);

    const hits = { claude: 0, gemini: 0, deepseek: 0, openai: 0 };
    const why = [];

    // 1) 文件名：明确出现模型标记 = 作者标注的适配模型，最高优先（kemini=Gemini、klaude/克劳德=Claude、ds/dsvN/ds预设=DeepSeek）
    const nameCats = [];
    for (const rule of NAME_RULES) {
        if (rule.re.test(nameLower)) { hits[rule.cat] += 3; nameCats.push(rule.cat); why.push('文件名[' + rule.cat + ']'); }
    }

    // 2) 配置意图：use_*_sysprompt 开关（预设保存/使用时的系统提示模板取向）
    const sysFlags = [
        { cat: 'claude', val: preset.claude_use_sysprompt },
        { cat: 'gemini', val: preset.use_makersuite_sysprompt },
        { cat: 'openai', val: preset.openai_use_sysprompt },
    ];
    for (const f of sysFlags) {
        if (f.val === true) { hits[f.cat] += 3; why.push('配置[use_' + f.cat + '_sysprompt]'); }
    }

    // 3) chat_completion_source（弱于名字/配置意图）
    if (source === 'claude' && hits.claude < 3) { hits.claude += 2; why.push('source=claude'); }
    else if (source === 'openai' && hits.openai < 3) { hits.openai += 2; why.push('source=openai'); }

    // 4) custom_model（source=custom 时的真实模型配置，+3；排除默认占位）
    const cm = String(preset.custom_model || '').toLowerCase().trim();
    if (source === 'custom' && cm && cm !== 'gpt-4-turbo') {
        for (const rule of NAME_RULES) {
            if (rule.re.test(cm)) { hits[rule.cat] += 3; why.push('custom_model[' + rule.cat + ']=' + cm); break; }
        }
    }

    // 5) 内容全文（prompts 含 disabled + 各文本字段）：模型关键词弱信号 +2（封顶 2，防长文刷分）
    if (text) {
        for (const rule of CONTENT_PATTERNS) {
            const m = text.match(rule.re);
            if (m) { hits[rule.cat] += Math.min(m.length, 2); why.push('内容[' + rule.cat + ']'); }
        }
    }

    // 决策：名字强信号优先（作者标注 > 当前配置 > 内容推断）
    let category;
    if (nameCats.length >= 3) category = 'multi';
    else if (nameCats.length === 2) {
        category = (nameCats.includes('claude') && nameCats.includes('gemini')) ? 'claude_gemini' : 'multi';
    }
    else if (nameCats.length === 1) category = nameCats[0];
    else {
        const strong = Object.entries(hits).filter(([, v]) => v >= 3).map(([k]) => k);
        const weak = Object.entries(hits).filter(([, v]) => v >= 1).map(([k]) => k);
        if (strong.length >= 3) category = 'multi';
        else if (strong.length === 2 && strong.includes('claude') && strong.includes('gemini')) category = 'claude_gemini';
        else if (strong.length === 2) category = 'multi';
        else if (strong.length === 1) category = strong[0];
        else if (weak.length >= 3) category = 'multi';
        else if (weak.length === 2 && weak.includes('claude') && weak.includes('gemini')) category = 'claude_gemini';
        else if (weak.length === 2) category = 'multi';
        else if (weak.length === 1) category = weak[0];
        else category = 'unknown';
    }

    return { category, label: CATEGORY_LABEL[category], color: CATEGORY_COLOR[category], hits, why };
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
    let committed = false;
    const commit = () => {
        if (committed) return;
        committed = true;
        const st = loadState();
        st.tags = st.tags || {};
        const v = input.value.trim();
        if (v) st.tags[name] = v;
        else delete st.tags[name];
        saveState();
        scanPresets();
        render();
    };
    input.addEventListener('keydown', (e) => {
        // 兼容手机端虚拟键盘：部分输入法回车键的 e.key 不是 'Enter'，用 keyCode 兜底
        if (e.key === 'Enter' || e.keyCode === 13) {
            commit();
        } else if (e.key === 'Escape' || e.keyCode === 27) {
            committed = true; // 取消时不保存，防止随后的 blur 误存
            render();
        }
        e.stopPropagation();
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    // 失焦兜底：手机端虚拟键盘回车可能不触发 keydown，失焦时同样保存
    input.addEventListener('blur', commit);
}

function buildFavRow(name) {
    const li = document.createElement('li');
    li.className = 'stpo-item stpo-fav-item';
    const main = document.createElement('div');
    main.className = 'stpo-item-main';
    const tag = getTags()[name] || '';
    const tagHtml = tag ? `<span class="stpo-tag" title="自定义标签">${escHtml(tag)}</span>` : '';
    main.innerHTML = `<span class="stpo-star">★</span><span class="stpo-name">${escHtml(name)}</span>${tagHtml}`;
    main.addEventListener('click', () => {
        const index = openai_setting_names?.[name];
        if (index !== undefined) applyPreset(index, name);
    });
    const ops = document.createElement('div');
    ops.className = 'stpo-item-ops';
    const mkBtn = (icon, cls, title, fn) => {
        const b = document.createElement('button');
        b.className = 'stpo-btn ' + cls;
        b.textContent = icon;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
    };
    ops.appendChild(mkBtn('↑', 'stpo-btn-up', '上移', () => moveFav(name, -1)));
    ops.appendChild(mkBtn('↓', 'stpo-btn-down', '下移', () => moveFav(name, 1)));
    ops.appendChild(mkBtn('✎', 'stpo-btn-tag', '编辑标签', () => startTagEdit(name, li)));
    ops.appendChild(mkBtn('☆', 'stpo-btn-star-off', '移出常用', () => toggleFav(name)));
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
    const mkBtn = (icon, cls, title, fn) => {
        const b = document.createElement('button');
        b.className = 'stpo-btn ' + cls;
        b.textContent = icon;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        return b;
    };
    const inFav = getFavorites().includes(item.name);
    ops.appendChild(mkBtn(inFav ? '★' : '☆', inFav ? 'stpo-btn-star-on' : 'stpo-btn-star', inFav ? '移出常用' : '加入常用', () => toggleFav(item.name)));
    ops.appendChild(mkBtn('⚙', 'stpo-btn-cat', '修改分类', () => showCategorySelect(item, li)));
    ops.appendChild(mkBtn('✎', 'stpo-btn-tag', '编辑标签', () => startTagEdit(item.name, li)));
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
    // stopPropagation：防止 render() 重建 DOM 后旧节点脱离面板，被 document 委托误判为"外部点击"而关闭面板
    header.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapsedCat(cat); });
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
            head.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapsedBase(key); });
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
        <div class="stpo-op-hint">点 ⚙ 改分类 · 点 ☆/★ 收藏到常用 · 点 ✎ 编辑标签</div>
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
    // 关闭/切换/外部点击 全部走 document 委托，元素被重建也不失效
    $(document).off('click.stpo').on('click.stpo', (e) => {
        const t = e.target;
        if (t.closest && t.closest('#stpo-close')) {
            panelVisible = false;
            $('#stpo-panel').removeClass('stpo-show');
            return;
        }
        if (t.closest && t.closest('#stpo-toggle')) {
            panelVisible = !panelVisible;
            $('#stpo-panel').toggleClass('stpo-show', panelVisible);
            if (panelVisible) { scanPresets(); render(); }
            return;
        }
        // 面板内交互（如点击分组/条目）触发 render() 后，原 e.target 会从 DOM 移除（isConnected=false），
        // 此时不得判为"外部点击"关闭面板；只有 target 仍连接在文档中且不在面板/按钮内才算外部点击
        if (panelVisible && e.target.isConnected && !$(e.target).closest('#stpo-panel').length && !$(e.target).closest('#stpo-toggle').length) {
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
    // 开关逻辑统一走 document 委托（initPanel 里绑定），避免双份代码/重建导致的事件叠加
    host.append(btn);
}

// ---------------- 样式注入 ----------------
// SillyTavern 1.19 对第三方扩展 manifest 的 css 字段注入失效（实测 style.css 未被服务端内联），
// 改为 JS 直接注入 <style>，与 st-chat-search 等扩展同方案，100% 生效
const STPO_CSS = `
/* ===== 预设分组管家 ===== */
/* 按钮用 ID+!important 压过酒馆自带 .menu_button 规则（1.19 下样式竞争） */
#stpo-toggle {
    width: 24px !important;
    height: 24px !important;
    padding: 3px !important;
    border-radius: 50% !important;
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    line-height: 1 !important;
    transition: transform 0.15s ease !important;
    margin: 0 !important;
    min-width: 0 !important;
}
#stpo-toggle:hover { transform: scale(1.12) !important; }
#stpo-toggle svg { display: block !important; }
#stpo-panel {
    display: none;
    position: fixed;
    top: 50%;
    right: 16px;
    transform: translateY(-50%);
    width: min(430px, calc(100vw - 40px));
    max-height: 82vh;
    background: var(--main-surface, #1e1e24);
    border: 1px solid var(--main-border-color, #3a3a44);
    border-radius: 10px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
    z-index: 2147483647;
    flex-direction: column;
    overflow: hidden;
    font-size: 13px;
    color: var(--main-font-color, #ddd);
}
/* 手机端：面板贴顶全宽，避免顶部被浏览器工具栏/顶部栏遮挡（dvh 按实际可视区计算） */
@media (max-width: 768px) {
    #stpo-panel {
        top: 8px;
        right: 8px;
        left: 8px;
        width: auto;
        transform: none;
        max-height: calc(100vh - 16px);
        max-height: calc(100dvh - 16px);
    }
}
#stpo-panel.stpo-show { display: flex; }
.stpo-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--main-border-color, #333);
    flex: 0 0 auto;
}
.stpo-title { font-weight: 700; white-space: nowrap; margin-right: 4px; }
#stpo-search {
    flex: 1;
    min-width: 0;
    background: var(--main-surface, #2a2a33);
    color: var(--main-font-color, #eee);
    border: 1px solid var(--main-border-color, #444);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 13px;
}
.stpo-fav {
    flex: 0 0 auto;
    max-height: 30%;
    overflow-y: auto;
    padding: 6px 8px;
    border-bottom: 1px dashed var(--main-border-color, #333);
}
.stpo-fav-title { font-weight: 700; margin-bottom: 4px; color: #f5c518; }
.stpo-hint { font-weight: 400; opacity: 0.6; font-size: 11px; }
.stpo-empty { padding: 8px; opacity: 0.5; font-size: 12px; }
.stpo-groups-wrap { flex: 1 1 auto; overflow-y: auto; padding: 4px 8px 8px; }
.stpo-list { list-style: none; margin: 0; padding: 0; }
.stpo-sub { padding-left: 14px; }
.stpo-item {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
}
.stpo-item:hover { background: var(--hover-surface, rgba(255, 255, 255, 0.06)); }
.stpo-item.stpo-current .stpo-name { color: #4cd9a8; font-weight: 700; }
.stpo-item-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
}
.stpo-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stpo-badge { flex: 0 0 auto; font-size: 10px; padding: 1px 6px; border-radius: 8px; white-space: nowrap; }
.stpo-tag {
    flex: 0 0 auto;
    font-size: 10px;
    background: #f5c51833;
    color: #f5c518;
    padding: 1px 6px;
    border-radius: 8px;
    white-space: nowrap;
    max-width: 90px;
    overflow: hidden;
    text-overflow: ellipsis;
}
.stpo-op-hint {
    padding: 4px 10px;
    font-size: 11px;
    opacity: 0.7;
    border-bottom: 1px dashed var(--main-border-color, #333);
    flex: 0 0 auto;
    color: var(--main-font-color, #ddd);
}
.stpo-item-ops { flex: 0 0 auto; display: flex; gap: 3px; opacity: 1; align-items: center; }
.stpo-btn {
    background: none;
    border: none;
    color: var(--main-font-color, #ddd);
    cursor: pointer;
    padding: 2px 5px;
    border-radius: 4px;
    font-size: 13px;
    line-height: 1;
    min-width: 18px;
    text-align: center;
}
.stpo-btn:hover { background: rgba(255, 255, 255, 0.12); }
.stpo-btn-star { color: #c8cdd6; }
.stpo-btn-star-on { color: #f5c518; }
.stpo-btn-cat { color: #7aa2f7; }
.stpo-btn-up, .stpo-btn-down { color: #7aa2f7; }
.stpo-btn-tag { color: #b48aea; }
.stpo-btn-star-off { color: #c8cdd6; }
.stpo-group { margin-bottom: 6px; }
.stpo-group-header, .stpo-base-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 700;
}
.stpo-group-header:hover, .stpo-base-head:hover { background: var(--hover-surface, rgba(255, 255, 255, 0.06)); }
.stpo-caret { width: 12px; text-align: center; font-size: 10px; opacity: 0.7; }
.stpo-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.stpo-count { margin-left: auto; font-size: 11px; opacity: 0.5; font-weight: 400; }
.stpo-base-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stpo-tag-input {
    flex: 1;
    min-width: 0;
    background: var(--main-surface, #2a2a33);
    color: var(--main-font-color, #eee);
    border: 1px solid #f5c51888;
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
}
.stpo-badge-edit { cursor: pointer; border: 1px dashed currentColor; }
.stpo-badge-edit:hover { filter: brightness(1.25); }
.stpo-cat-select {
    flex: 0 0 auto;
    font-size: 11px;
    background: var(--main-surface, #2a2a33);
    color: var(--main-font-color, #eee);
    border: 1px solid var(--main-border-color, #555);
    border-radius: 8px;
    padding: 1px 4px;
    max-width: 150px;
}
.stpo-foot { padding: 6px 2px 2px; font-size: 10px; opacity: 0.45; text-align: center; }
`;

function injectStyles() {
    if (document.getElementById('stpo-style')) return;
    const st = document.createElement('style');
    st.id = 'stpo-style';
    st.textContent = STPO_CSS;
    document.head.appendChild(st);
}

function init() {
    injectStyles();
    if (typeof openai_settings === 'undefined' || !openai_setting_names) {
        setTimeout(init, 1000);
        return;
    }
    // 防双载：同一页面两份 JS（缓存旧版 + 新版）同时执行时，只允许一份真正初始化，
    // 并强制清除全部残留节点（无论旧版用的什么 ID 都尝试移除）
    const STPO_IDS = ['#stpo-panel', '#stpo-toggle', '#stpo-fav-list', '#stpo-groups'];
    document.querySelectorAll(STPO_IDS.join(',')).forEach((e) => e.remove());
    document.querySelectorAll('[id*="stpo-"][id*="panel"], [id*="preset-organizer"], .stpo-panel, .stpo-toggle').forEach((e) => e.remove());
    if (window.__stpoLoaded) {
        // 第二份代码：不再重复建面板，但兜底修复可能存在的旧残留
        if (!document.querySelector('#stpo-panel')) { initPanel(); addToggleButton(); }
        return;
    }
    window.__stpoLoaded = true;
    initPanel();
    addToggleButton();

    // MutationObserver 兜底：任何时刻出现第二个面板/按钮，立即移除多余的
    if (!window.__stpoObserver) {
        window.__stpoObserver = new MutationObserver(() => {
            const panels = document.querySelectorAll('#stpo-panel');
            for (let i = 1; i < panels.length; i++) panels[i].remove();
            const toggles = document.querySelectorAll('#stpo-toggle');
            for (let i = 1; i < toggles.length; i++) toggles[i].remove();
        });
        window.__stpoObserver.observe(document.body, { childList: true, subtree: true });
    }
}

// 等酒馆设置加载完成
eventSource.on(eventTypes.APP_READY, init);
setTimeout(init, 3000); // 兜底
