// 南开大学（研究生）教育综合管理系统 拾光课程表适配脚本
// 适用系统: https://yjs.nankai.edu.cn/   入口: 培养 → 个人课表 (py/page/student/grkcb.htm)
//
// 与常见教务系统的差别（决定了本脚本的实现方式）:
//   1. 服务端渲染(JSP)输出 HTML 表格, 没有 JSON 接口, 只能解析 DOM;
//   2. 表格以周次参数 zc 分周渲染, 同一门课只在它真正上课的那一周出现, 单元格里的
//      「十七周 / 前八周」只是说明文字。因此逐周抓取第 1~N 周, 用「在第几周出现过」还原
//      真实周次; 同时保留说明文字解析, 一旦抓到周次超出说明范围（说明系统其实每周返回
//      同一份完整课表）就改用说明文字推导;
//   3. 课表用 rowspan 跨节次, 必须先展开成网格才能定位星期;
//   4. 「时间地点待定」的课程没有星期与节次, 抓取前单独弹红色警告确认框, 确认后才继续。
//
// 维护者: Cure   |   出现问题请提 issues 或提交 PR

/* 整个脚本包在 IIFE 中: 不污染教务页面的全局作用域, 且被重复注入时顶层 const 不会重复声明。
   为保持 diff 可读, 函数体不再向内缩进一级。 */
(function () {
'use strict';

/* ============================ 常量 ============================ */

// 课表页路径（系统内所有页面均为 /<模块>/page/<角色>/<页面>.htm 结构）
const NKU_KB_PAGE = '/py/page/student/grkcb.htm';

// 逐周抓取的并发数（同一 JSP 会话并发过高会被串行化, 3 比较稳）
const NKU_FETCH_CONCURRENCY = 3;

// 学期代码(#xj) -> 开学日期推算基准。系统不提供校历, 这里只给出候选日期供用户确认。
const NKU_TERM_BASE = {
    '11': { month: 8, day: 1, yearOffset: 0 }, // 第一学期: 当年 9 月 1 日之后第一个周一
    '13': { month: 5, day: 20, yearOffset: 0 }, // 短学期:  当年 6 月 20 日之后第一个周一
    '12': { month: 1, day: 20, yearOffset: 1 } // 第二学期: 次年 2 月 20 日之后第一个周一
};

// 兜底作息（正常情况下从课表页底部的说明文字解析, 这里只作解析失败时的保底）
// 下标 + 1 即节次
const NKU_FALLBACK_TIME_SLOTS = [
    '08:00-08:45', '08:55-09:40', '10:00-10:45', '10:55-11:40', '12:00-12:45',
    '12:55-13:40', '14:00-14:45', '14:55-15:40', '16:00-16:45', '16:55-17:40',
    '18:30-19:15', '19:25-20:10', '20:20-21:05', '21:15-22:00'
].map((range, index) => {
    const [startTime, endTime] = range.split('-');
    return { number: index + 1, startTime, endTime };
});

// 警告弹窗配色: showAlert 只接受纯文本, 没有颜色参数, 只能趁弹窗显示期间往页面插一段样式,
// 选择器沿用插件内联对话框的 id, 用 !important 压过它的内联样式。找不到这些节点时不生效。
const NKU_WARNING_STYLE_ID = 'nku-pending-warning-style';
const NKU_WARNING_CSS = [
    '#bridge-dialog-container { border: 2px solid #d93025 !important; }',
    '#bridge-dialog-container h3 { color: #d93025 !important; }',
    '#bridge-dialog-container button { background-color: #d93025 !important; }'
].join('\n');

/* ============================ 通用工具 ============================ */

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 中文数字 -> 整数（支持 一 ~ 九十九）; 无法解析返回 NaN */
function cnToInt(text) {
    const s = String(text || '').replace(/\s/g, '');
    if (!s) return NaN;
    if (s === '十') return 10;
    if (s.length === 1) return Object.prototype.hasOwnProperty.call(CN_DIGITS, s) ? CN_DIGITS[s] : NaN;
    const idx = s.indexOf('十');
    if (idx === -1) return NaN;
    const high = idx === 0 ? 1 : CN_DIGITS[s[idx - 1]];
    const low = idx === s.length - 1 ? 0 : CN_DIGITS[s[idx + 1]];
    return (high === undefined || low === undefined) ? NaN : high * 10 + low;
}

/** 中文或阿拉伯数字 -> 整数 */
function toInt(token) {
    const s = String(token || '').trim();
    return /^\d+$/.test(s) ? Number(s) : cnToInt(s);
}

/** 规整空白与全角空格 */
function normalizeText(text) {
    return String(text == null ? '' : text).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "8:00" / "08:00:00" -> "08:00"; 非法返回 null */
function formatTime(value) {
    const match = typeof value === 'string' ? value.match(/^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/) : null;
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** "08:45" -> 525; 非法返回 -1 */
function timeToMinutes(value) {
    const t = formatTime(value);
    return t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : -1;
}

/** 日期 -> "YYYY-MM-DD" */
function formatDate(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 连续整数区间 -> 升序数组 */
function makeRange(from, to) {
    const out = [];
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) out.push(i);
    return out;
}

/** 去重并升序 */
const uniqueSorted = numbers => Array.from(new Set(numbers)).sort((a, b) => a - b);

/* ============================ 桥接层 ============================ */

function showToast(message) {
    try { window.shiguangBridge.showToast(message); } catch { /* 提示失败不打断导入 */ }
}

function notifyTaskCompletion() {
    try { window.shiguangBridge.notifyTaskCompletion(); } catch { /* 结束信号交给宿主处理 */ }
}

/** 应用内执行时 shiguangBridgePromise 一定存在, 这里仍然检查 */
const bridgeSupports = method =>
    !!(window.shiguangBridgePromise && typeof window.shiguangBridgePromise[method] === 'function');

/** 红色警告配色: 只在我们的弹窗显示期间生效, 用完立刻撤掉, 避免影响其它弹窗 */
function applyWarningStyle() {
    try {
        if (document.getElementById(NKU_WARNING_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = NKU_WARNING_STYLE_ID;
        style.textContent = NKU_WARNING_CSS;
        (document.head || document.documentElement).appendChild(style);
    } catch { /* 配色是锦上添花, 失败不影响弹窗与导入 */ }
}

function removeWarningStyle() {
    try {
        const style = document.getElementById(NKU_WARNING_STYLE_ID);
        if (style) style.remove();
    } catch { /* 同上, 撤不掉也不影响导入 */ }
}

/* ============================ 页面解析 ============================ */

/** 把表格展开成二维网格, 正确处理 rowspan / colspan（课表用 rowspan 跨节次） */
function buildTableGrid(table) {
    const grid = [];
    const occupied = [];

    Array.from(table.querySelectorAll('tr')).forEach((tr, rowIndex) => {
        let col = 0;
        Array.from(tr.children).forEach(cell => {
            const tag = (cell.tagName || '').toLowerCase();
            if (tag !== 'td' && tag !== 'th') return;

            while (occupied[rowIndex] && occupied[rowIndex][col]) col++;
            const colspan = Math.max(parseInt(cell.getAttribute('colspan') || '1', 10) || 1, 1);
            const rowspan = Math.max(parseInt(cell.getAttribute('rowspan') || '1', 10) || 1, 1);

            for (let i = 0; i < rowspan; i++) {
                const r = rowIndex + i;
                grid[r] = grid[r] || [];
                occupied[r] = occupied[r] || [];
                for (let j = 0; j < colspan; j++) {
                    if (!i && !j) grid[r][col] = cell;
                    occupied[r][col + j] = true;
                }
            }
            col += colspan;
        });
    });

    return grid;
}

/** 表头形如 <th colspan="2">时间</th><th>星期一</th>… -> { 列下标: 星期(1~7) } */
function findDayColumns(grid) {
    const dayChars = '一二三四五六日';
    const map = {};
    (grid[0] || []).forEach((cell, col) => {
        if (!cell) return;
        const match = normalizeText(cell.textContent).replace(/\s/g, '').match(/^星期([一二三四五六日天])$/);
        if (!match) return;
        const day = dayChars.indexOf(match[1] === '天' ? '日' : match[1]) + 1;
        if (day >= 1 && day <= 7) map[col] = day;
    });
    return map;
}

/** 课表主表格 */
function findTimetable(doc) {
    const direct = doc.querySelector('table.table-course');
    if (direct && /星期/.test(direct.textContent || '')) return direct;

    return Array.from(doc.querySelectorAll('table')).find(table =>
        /星期一/.test(table.textContent || '') && /第\s*\d+\s*节/.test(table.textContent || '')) || null;
}

/** 单元格里的 <a> -> 按行切分的文本数组（<br> 视为换行）
 *  典型内容: 群论 / || 十七周 / 第1节 -- 第2节 / 朱开恩 / 主楼333 */
function anchorToLines(anchor) {
    const clone = anchor.cloneNode(true);
    Array.from(clone.querySelectorAll('br')).forEach(br => {
        br.parentNode.replaceChild(document.createTextNode('\n'), br);
    });
    return String(clone.textContent || '').replace(/\u00a0/g, ' ').split('\n')
        .map(line => normalizeText(line)).filter(Boolean);
}

/** 解析一个课程链接 -> { name, teacher, position, day, startSection, endSection, weekDesc } */
function parseCourseAnchor(anchor, day) {
    const lines = anchorToLines(anchor);
    const strong = anchor.querySelector('strong');
    let name = normalizeText(strong ? strong.textContent : '') || normalizeText(lines[0] || '');
    name = name.replace(/^[|\s]+/, '');
    if (!name) return null;

    // 「第X节 -- 第Y节」所在行
    const sectionIdx = lines.findIndex(line => /第\s*\d+\s*节/.test(line));
    if (sectionIdx < 0) return null;

    // 周次说明位于课程名与节次行之间（形如 "|| 十七周"）, 只用于兜底与自检
    const weekDesc = normalizeText(lines.slice(1, sectionIdx).join(' ').replace(/[|｜]/g, ' '));

    const numbers = (lines[sectionIdx].match(/第\s*(\d+)\s*节/g) || [])
        .map(token => Number(token.replace(/\D/g, ''))).filter(num => num > 0);
    if (!numbers.length) return null;

    // 教师 / 地点紧随节次行; 有些课程没有独立教师行, 此时第一行其实是地点
    let teacher = normalizeText(lines[sectionIdx + 1] || '');
    let position = normalizeText(lines[sectionIdx + 2] || '');
    if (!position && /楼|室|馆|场地|校区|通知|待定/.test(teacher)) {
        position = teacher;
        teacher = '';
    }

    if (!(day >= 1 && day <= 7)) return null;
    return {
        name,
        teacher,
        position: position || '待定',
        day,
        startSection: Math.min.apply(null, numbers),
        endSection: Math.max.apply(null, numbers),
        weekDesc
    };
}

/** 解析某一周课表页面里的所有课程; null 表示页面里找不到课表（可能登录已失效） */
function parseTimetableDoc(doc) {
    const table = findTimetable(doc);
    if (!table) return null;

    const grid = buildTableGrid(table);
    const dayColumns = findDayColumns(grid);
    const colKeys = Object.keys(dayColumns);
    if (colKeys.length === 0) return null;

    const courses = [];
    for (let row = 1; row < grid.length; row++) {
        colKeys.forEach(key => {
            const cell = grid[row] ? grid[row][Number(key)] : null;
            if (!cell) return;
            // 同一格可能塞了多门课（冲突课程）, 逐个解析
            Array.from(cell.querySelectorAll('a'))
                .filter(anchor => /第\s*\d+\s*节/.test(anchor.textContent || ''))
                .forEach(anchor => {
                    const course = parseCourseAnchor(anchor, dayColumns[key]);
                    if (course) courses.push(course);
                });
        });
    }
    return courses;
}

/** 从页面底部说明文字解析作息时间, 形如 "上午:第一节 8:00-8:45 第二节8:55-9:40 …"
 *  桥接层要求时间段从 1 开始且编号连续, 不满足则整体放弃（返回 null 交给兜底表） */
function parseTimeSlotsFromDoc(doc) {
    const bodyText = doc && doc.body ? doc.body.textContent || '' : '';
    if (!bodyText) return null;

    const normalized = bodyText
        .replace(/[：]/g, ':')
        .replace(/[–—~～至]/g, '-')
        .replace(/\s+/g, ' ');
    const pattern = /第([一二三四五六七八九十]+)节?:?\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/g;
    const collected = new Map();
    let match;

    while ((match = pattern.exec(normalized)) !== null) {
        const number = cnToInt(match[1]);
        const startTime = formatTime(match[2]);
        const endTime = formatTime(match[3]);
        if (!number || !startTime || !endTime) continue;
        if (timeToMinutes(startTime) >= timeToMinutes(endTime)) continue;
        collected.set(number, { number, startTime, endTime });
    }

    const slots = Array.from(collected.values()).sort((a, b) => a.number - b.number);
    if (!slots.length) return null;
    return slots.every((slot, index) => slot.number === index + 1) ? slots : null;
}

/** 解析「以下课程时间地点待定」表格（表头同时含 课程名称 与 上课时间） */
function parsePendingCourses(doc) {
    const result = [];

    Array.from(doc.querySelectorAll('table')).forEach(table => {
        const headerCells = Array.from(table.querySelectorAll('thead th'))
            .map(th => normalizeText(th.textContent));
        const headerText = headerCells.join(' ');
        if (!/课程名称/.test(headerText) || !/上课时间/.test(headerText)) return;

        const headers = headerCells.length ? headerCells
            : Array.from(table.querySelectorAll('tr:first-child td, tr:first-child th'))
                .map(cell => normalizeText(cell.textContent));
        const indexOf = keyword => headers.findIndex(header => header.indexOf(keyword) !== -1);
        const column = {
            code: indexOf('课程编号'),
            name: indexOf('课程名称'),
            teacher: indexOf('任课教师'),
            time: indexOf('上课时间'),
            position: indexOf('上课地点'),
            remark: indexOf('备注')
        };

        Array.from(table.querySelectorAll('tbody tr')).forEach(tr => {
            const cells = Array.from(tr.querySelectorAll('td'));
            if (!cells.length) return;
            const value = key => (column[key] >= 0 && cells[column[key]])
                ? normalizeText(cells[column[key]].textContent) : '';
            const name = value('name');
            if (!name) return;
            result.push({
                code: value('code'),
                name,
                teacher: value('teacher'),
                time: value('time'),
                position: value('position'),
                remark: value('remark')
            });
        });
    });

    return result;
}

/** 待定课程 -> 弹窗正文的多行文本, 每门一行: 1. 实验室安全教育（吴强 · 时间待定 · 场地详见学院通知）
 *  超过 limit 门时只列前 limit 门并汇总, 避免弹窗被撑爆 */
function formatPendingCourses(pendingCourses, limit) {
    const max = (typeof limit === 'number' && limit > 0) ? limit : 8;
    const lines = pendingCourses.slice(0, max).map((course, index) => {
        const details = [course.teacher, course.time, course.position, course.remark]
            .map(item => normalizeText(item)).filter(Boolean);
        return `${index + 1}. ${course.name}${details.length ? `（${details.join(' · ')}）` : ''}`;
    });
    if (pendingCourses.length > max) lines.push(`… 等共 ${pendingCourses.length} 门`);
    return lines.join('\n');
}

/** 「时间地点待定」确认弹窗: 逐条列清并等用户确认
 *  确认（或环境不支持弹窗）-> 继续导入; 取消 -> 整个导入中止, 不写任何数据 */
async function confirmPendingCourses(pendingCourses) {
    if (!pendingCourses.length) return true;

    if (!bridgeSupports('showAlert')) {
        showToast(`⚠️ 另有 ${pendingCourses.length} 门「时间地点待定」课程无法导入课表, 请手动添加。`);
        return true;
    }

    const title = `⚠️ 有 ${pendingCourses.length} 门课程时间地点待定`;
    const content = `⚠️ 以下 ${pendingCourses.length} 门课程在系统中没有具体的上课时间与地点, `
        + `无法写入课表, 需要你在导入完成后手动添加：\n\n${formatPendingCourses(pendingCourses)}`
        + '\n\n✅ 以上课程不影响其余课程的导入。';

    applyWarningStyle();
    try {
        return await window.shiguangBridgePromise.showAlert(title, content, '继续导入') === true;
    } catch {
        return true;
    } finally {
        removeWarningStyle();
    }
}

/* ============================ 周次推导 ============================ */

const WEEK_NUM = '([\\d一二三四五六七八九十]+)';

/** 中文周次说明 -> 周次数组, 无法解析返回 null。常见语义:
 *    前X周 -> 1~X;  后X周 -> 最后 X 周;  第X周 -> 仅第 X 周;  "X周" -> 从第 1 周起持续 X 周
 *  单周 / 双周 作为修饰再过滤 */
function parseWeekDescToWeeks(desc, totalWeeks) {
    const s = normalizeText(desc).replace(/\s/g, '').replace(/[~～至–—ー]/g, '-');
    const range = s.match(new RegExp(`第?${WEEK_NUM}-第?${WEEK_NUM}周`));
    const head = s.match(new RegExp(`前${WEEK_NUM}周`));
    const tail = s.match(new RegExp(`后${WEEK_NUM}周`));
    const exact = s.match(new RegExp(`第${WEEK_NUM}周`));
    const bare = s.match(new RegExp(`^${WEEK_NUM}周`));

    let weeks = null;
    if (range && toInt(range[1]) > 0 && toInt(range[2]) > 0) {
        weeks = makeRange(toInt(range[1]), toInt(range[2]));
    } else if (head && toInt(head[1]) > 0) {
        weeks = makeRange(1, toInt(head[1]));
    } else if (tail && toInt(tail[1]) > 0) {
        weeks = makeRange(Math.max(1, totalWeeks - toInt(tail[1]) + 1), totalWeeks);
    } else if (exact && toInt(exact[1]) > 0) {
        weeks = [toInt(exact[1])];
    } else if (bare && toInt(bare[1]) > 0) {
        // 形如 "十七周" —— 视为从第 1 周起持续 17 周
        weeks = makeRange(1, toInt(bare[1]));
    }
    if (!weeks) return null;

    if (/单周/.test(s)) weeks = weeks.filter(week => week % 2 === 1);
    if (/双周/.test(s)) weeks = weeks.filter(week => week % 2 === 0);
    return weeks.length ? uniqueSorted(weeks) : null;
}

/* ============================ 抓取与归并 ============================ */

/** <select> 的选项 -> [{ value, label, selected }] */
function readSelectOptions(selectEl) {
    if (!selectEl) return [];
    return Array.from(selectEl.querySelectorAll('option'))
        .map(option => ({
            value: normalizeText(option.value),
            label: normalizeText(option.textContent || option.value),
            selected: option.selected === true || option.hasAttribute('selected')
        }))
        .filter(option => option.value !== '');
}

/** 取默认项: 优先页面已选中的, 否则取候选下标（越界则取首尾） */
function pickDefault(options, fallbackIndex) {
    if (!options.length) return '';
    const selected = options.find(option => option.selected);
    if (selected) return selected.value;
    return options[Math.min(Math.max(fallbackIndex, 0), options.length - 1)].value;
}

/** 文档是否为本系统的课表页（用于区分「页面结构变了 / 登录失效」和「这一周没课」） */
function looksLikeCoursePage(doc) {
    if (!doc) return false;
    if (doc.querySelector('#xn') || doc.querySelector('#xj') || doc.querySelector('#kcbForm')) return true;
    return /课表|南开大学/.test(doc.title || '');
}

/** 抓取某一周的课表页面; CAS 登录失效时请求会被重定向到统一认证页, 这里显式报错 */
async function fetchWeekDoc(xn, xj, zc) {
    const url = `${NKU_KB_PAGE}?xn=${encodeURIComponent(xn)}&xj=${encodeURIComponent(xj)}&zc=${encodeURIComponent(zc)}`;
    const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'X-Requested-With': 'XMLHttpRequest'
        }
    });

    if (!response.ok) throw new Error(`第 ${zc} 周课表请求失败，状态码 ${response.status}`);

    const finalUrl = response.url || '';
    if (finalUrl && !/\/py\/page\/student\/grkcb\.htm/.test(finalUrl)) {
        throw new Error(`第 ${zc} 周课表请求被重定向（${finalUrl}），登录状态可能已失效`);
    }
    return new DOMParser().parseFromString(await response.text(), 'text/html');
}

/** 读取「时间地点待定」课程。页面上的待定表跟随页面当前学期, 用户选了别的学期就不准了,
 *  所以按选定的学年学期重新抓一次课表页; 抓取失败则退回当前页面（不会比原来更差）。 */
async function fetchPendingCourses(xn, xj) {
    try {
        const list = parsePendingCourses(await fetchWeekDoc(xn, xj, 1));
        if (list.length) return list;
    } catch { /* 退回当前页面 */ }
    return parsePendingCourses(document);
}

/** 简单的并发池 */
async function runWithConcurrency(tasks, limit) {
    const results = new Array(tasks.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < tasks.length) {
            const index = cursor++;
            results[index] = await tasks[index]();
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
}

/** 抓取第 1 ~ maxWeek 周, 汇总每门课出现在哪些周 */
async function crawlAllWeeks(xn, xj, maxWeek) {
    showToast(`正在抓取第 1 ~ ${maxWeek} 周课表，请稍候…（共 ${maxWeek} 次请求）`);

    const tasks = makeRange(1, maxWeek).map(week => async () => {
        try {
            const doc = await fetchWeekDoc(xn, xj, week);
            const courses = parseTimetableDoc(doc);
            if (courses) return { week, courses };
            // 是本系统的课表页却没有表格 —— 多为超出本学期周次范围, 按无课处理
            if (looksLikeCoursePage(doc)) return { week, courses: [] };
            return { week, courses: null };
        } catch {
            return { week, courses: null };
        }
    });

    const results = await runWithConcurrency(tasks, NKU_FETCH_CONCURRENCY);
    const courses = [];
    const failedWeeks = [];
    const okWeeks = [];

    results.forEach(result => {
        if (!result) return;
        if (result.courses === null) {
            failedWeeks.push(result.week);
            return;
        }
        okWeeks.push(result.week);
        result.courses.forEach(course => courses.push(Object.assign({}, course, { week: result.week })));
    });

    return { courses, failedWeeks, okWeeks };
}

/** 按「课程名 + 教师 + 地点 + 星期 + 节次」归并各周记录 -> 每门课的周次集合 */
function groupCoursesBySignature(records) {
    const groups = new Map();
    records.forEach(course => {
        const key = [course.name, course.teacher, course.position, course.day, course.startSection, course.endSection]
            .join('\u0001');
        if (!groups.has(key)) groups.set(key, Object.assign({}, course, { crawlWeeks: new Set() }));
        const group = groups.get(key);
        group.crawlWeeks.add(course.week);
        if (!group.weekDesc && course.weekDesc) group.weekDesc = course.weekDesc;
    });
    return Array.from(groups.values());
}

/** 决定每门课最终的周次。默认信任抓取结果（第几周出现过就是第几周）; 但若同一门课出现的
 *  周次明显超出它自己的说明范围（分周渲染时不可能发生）, 说明系统其实每周返回同一份完整
 *  课表, 此时改用说明文字推导。为避免个别偏差带偏整体, 要求「至少 2 门且不少于半数」矛盾。 */
function resolveWeeks(groups, totalWeeks) {
    const stats = groups.map(group => {
        const textWeeks = parseWeekDescToWeeks(group.weekDesc, totalWeeks);
        const crawlWeeks = uniqueSorted(Array.from(group.crawlWeeks));
        const violated = !!textWeeks && !crawlWeeks.every(week => textWeeks.indexOf(week) !== -1);
        return { group, textWeeks, crawlWeeks, violated };
    });

    const parsedCount = stats.filter(item => item.textWeeks).length;
    const violatedCount = stats.filter(item => item.violated).length;
    const useText = violatedCount >= 2 && violatedCount * 2 >= parsedCount;

    return stats.map(item => {
        let weeks = (useText && item.textWeeks) ? item.textWeeks : item.crawlWeeks;
        if (!weeks || !weeks.length) weeks = makeRange(1, totalWeeks);
        return {
            name: item.group.name,
            teacher: item.group.teacher,
            position: item.group.position,
            day: item.group.day,
            startSection: item.group.startSection,
            endSection: item.group.endSection,
            weeks: uniqueSorted(weeks)
        };
    });
}

/** 合并「同一门课、同一天、同一周次、节次相邻」的碎片（系统有时会拆成两格） */
function mergeAdjacentSections(courses) {
    const buckets = new Map();
    courses.forEach(course => {
        const key = [course.name, course.teacher, course.position, course.day, course.weeks.join(',')]
            .join('\u0001');
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(course);
    });

    const merged = [];
    buckets.forEach(list => {
        list.sort((a, b) => a.startSection - b.startSection || a.endSection - b.endSection);
        let current = null;
        list.forEach(course => {
            if (current && course.startSection <= current.endSection + 1) {
                current.endSection = Math.max(current.endSection, course.endSection);
            } else {
                if (current) merged.push(current);
                current = Object.assign({}, course);
            }
        });
        if (current) merged.push(current);
    });
    return merged;
}

/* ============================ 页面参数与交互 ============================ */

/** 读取页面上的学年 / 学期 / 周次选项; 当前页面不是课表页时抓一次课表页再解析 */
async function extractPageParams() {
    const pick = doc => ['#xn', '#xj', '#zc'].map(selector => doc.querySelector(selector));
    let [xnEl, xjEl, zcEl] = pick(document);

    if (!xnEl || !xjEl || !zcEl) {
        try {
            const response = await fetch(NKU_KB_PAGE, { method: 'GET', credentials: 'include' });
            [xnEl, xjEl, zcEl] = pick(new DOMParser().parseFromString(await response.text(), 'text/html'));
        } catch { /* 读不到参数时下面会给出提示 */ }
    }

    const xn = readSelectOptions(xnEl);
    const xj = readSelectOptions(xjEl);
    const zc = readSelectOptions(zcEl);
    return {
        xn,
        xj,
        zc,
        curXn: pickDefault(xn, xn.length - 1) || String(new Date().getFullYear()),
        curXj: pickDefault(xj, 0) || '11',
        curZc: pickDefault(zc, 0) || '1'
    };
}

/** 生成学年学期候选（限制在页面所选学年前后各 2 年, 避免列表过长） */
function buildTermOptions(xnOptions, xjOptions, curXn, curXj) {
    const baseYear = Number(curXn) || new Date().getFullYear();
    let years = xnOptions.filter(option => Math.abs(Number(option.value) - baseYear) <= 2);
    if (!years.length) years = xnOptions.slice(-4);
    // 保证当前学年一定在列表里
    if (years.length && !years.some(option => option.value === curXn)) {
        const current = xnOptions.find(option => option.value === curXn);
        if (current) years = years.concat([current]).sort((a, b) => Number(a.value) - Number(b.value));
    }

    const labels = [];
    const values = [];
    let defaultIndex = 0;
    years.forEach(yearOption => xjOptions.forEach(termOption => {
        const label = `${yearOption.label}学年 ${termOption.label}`;
        if (yearOption.value === curXn && termOption.value === curXj) defaultIndex = labels.length;
        labels.push(label);
        values.push({ xn: yearOption.value, xj: termOption.value, label });
    }));

    return labels.length ? { labels, values, defaultIndex } : null;
}

/** 让用户选择要导入的学年学期, 默认选中页面上当前显示的学期; 取消返回 null */
async function selectAcademicYearAndSemester(params) {
    const options = buildTermOptions(params.xn, params.xj, params.curXn, params.curXj);
    if (!options) return { xn: params.curXn, xj: params.curXj, label: '当前学期' };
    if (!bridgeSupports('showSingleSelection')) return options.values[options.defaultIndex];

    const selected = await window.shiguangBridgePromise.showSingleSelection(
        '选择学年学期',
        JSON.stringify(options.labels),
        options.defaultIndex
    );
    if (selected === null || selected === undefined || selected < 0) return null;
    return options.values[selected];
}

/** 第 1 周周一（开学日期）的推算值。系统不提供校历, 只按学期类型估算, 由用户确认。 */
function guessTermStartDate(xn, xj) {
    const rule = NKU_TERM_BASE[String(xj)] || NKU_TERM_BASE['11'];
    const base = new Date((Number(xn) || new Date().getFullYear()) + rule.yearOffset, rule.month, rule.day);
    const dayOfWeek = base.getDay(); // 0 = 周日
    base.setDate(base.getDate() + (dayOfWeek === 1 ? 0 : (dayOfWeek === 0 ? 1 : 8 - dayOfWeek)));
    return formatDate(base);
}

/** 让用户从推算值前后各 3 周的候选中确认开学日期; 取消返回 null */
async function selectSemesterStartDate(xn, xj) {
    const guess = guessTermStartDate(xn, xj);
    const guessDate = new Date(`${guess}T00:00:00`);
    const dates = [];
    const labels = [];
    let defaultIndex = 0;

    for (let offset = -3; offset <= 3; offset++) {
        const date = new Date(guessDate.getTime());
        date.setDate(date.getDate() + offset * 7);
        if (offset === 0) defaultIndex = dates.length;
        dates.push(formatDate(date));
        labels.push(`${dates[dates.length - 1]}（周一）`);
    }

    if (!bridgeSupports('showSingleSelection')) return guess;

    const selected = await window.shiguangBridgePromise.showSingleSelection(
        '确认第 1 周周一（开学日期）\n系统未提供开学日期, 请选择第 1 周的周一',
        JSON.stringify(labels),
        defaultIndex
    );
    if (selected === null || selected === undefined || selected < 0) return null;
    return dates[selected];
}

/* ============================ 保存 ============================ */

/** 调用桥接层的保存接口; 失败时提示用户并返回 false */
async function saveVia(method, payload, failMessage) {
    try {
        await window.shiguangBridgePromise[method](JSON.stringify(payload));
        return true;
    } catch (error) {
        showToast(`${failMessage}: ${error.message}`);
        return false;
    }
}

/** 从作息时间推算单节课与课间时长, 用于课表配置 */
function deriveDurations(timeSlots) {
    const fallback = { classDuration: 45, breakDuration: 10 };
    if (!Array.isArray(timeSlots) || timeSlots.length < 2) return fallback;

    const classDuration = timeToMinutes(timeSlots[0].endTime) - timeToMinutes(timeSlots[0].startTime);
    const breakDuration = timeToMinutes(timeSlots[1].startTime) - timeToMinutes(timeSlots[0].endTime);
    return (classDuration > 0 && breakDuration >= 0) ? { classDuration, breakDuration } : fallback;
}

/* ============================ 主流程 ============================ */

function isLoginPage() {
    return /iam\.nankai\.edu\.cn|cas\/login|pageAction=Logout/i.test(window.location.href || '');
}

async function promptUserToStart() {
    if (!bridgeSupports('showAlert')) return true;
    try {
        return await window.shiguangBridgePromise.showAlert(
            '南开大学研究生课表导入',
            '导入前请确认已登录南开大学研究生教育综合管理系统, 并停留在「培养 → 个人课表」页面。\n\n'
            + '本脚本将自动读取作息时间, 逐周抓取课表并还原每门课的实际周次。'
            + '若课表周次较多, 抓取可能需要十几秒。',
            '开始导入'
        ) === true;
    } catch {
        return true;
    }
}

async function importFlow() {
    if (isLoginPage()) {
        showToast('导入失败：请先登录南开大学研究生教育综合管理系统！');
        return;
    }
    if (!looksLikeCoursePage(document)) {
        showToast('导入失败：请先打开「培养 → 个人课表」页面再执行本脚本。');
        return;
    }
    if (!await promptUserToStart()) {
        showToast('已取消导入。');
        return;
    }

    // 1. 页面参数与学年学期
    const params = await extractPageParams();
    if (!params.xn.length || !params.xj.length || !params.zc.length) {
        showToast('未能读取到学年/学期/周次信息，请确认已在「个人课表」页面。');
        return;
    }
    const term = await selectAcademicYearAndSemester(params);
    if (!term) {
        showToast('已取消导入（未选择学年学期）。');
        return;
    }
    const { xn, xj, label } = term;
    const totalWeeks = params.zc.length;

    // 2. 作息时间: 从当前页面解析, 失败时用兜底表
    const timeSlots = parseTimeSlotsFromDoc(document) || NKU_FALLBACK_TIME_SLOTS;

    // 3. 「时间地点待定」课程单独确认 —— 放在耗时的逐周抓取之前, 取消就不用等了
    const pendingCourses = await fetchPendingCourses(xn, xj);
    if (!await confirmPendingCourses(pendingCourses)) {
        showToast('已取消导入（「时间地点待定」课程未确认）。');
        return;
    }

    // 4. 逐周抓取并归并出每门课的真实周次
    const crawl = await crawlAllWeeks(xn, xj, totalWeeks);
    if (!crawl.okWeeks.length) {
        showToast('课表抓取失败：所有周次都未取到数据，请确认登录状态后重试。');
        return;
    }
    if (!crawl.courses.length) {
        showToast(`${label} 未查询到任何课程，可能本学期无课或尚未选课。`);
        return;
    }

    const courses = mergeAdjacentSections(resolveWeeks(groupCoursesBySignature(crawl.courses), totalWeeks))
        .sort((a, b) => a.day - b.day
            || a.startSection - b.startSection
            || a.name.localeCompare(b.name, 'zh-Hans-CN'))
        .map(course => ({
            name: course.name,
            teacher: course.teacher,
            position: course.position,
            day: course.day,
            startSection: course.startSection,
            endSection: course.endSection,
            weeks: course.weeks
        }));

    // 5. 保存: 课程 -> 作息时间 -> 课表配置
    if (!await saveVia('saveImportedCourses', courses, '课程保存失败')) return;
    await saveVia('savePresetTimeSlots', timeSlots, '导入作息时间失败');

    const startDate = await selectSemesterStartDate(xn, xj);
    const durations = deriveDurations(timeSlots);
    await saveVia('saveCourseConfig', {
        semesterStartDate: startDate || null,
        semesterTotalWeeks: courses.reduce((max, course) => Math.max(max, ...course.weeks), 1),
        defaultClassDuration: durations.classDuration,
        defaultBreakDuration: durations.breakDuration,
        firstDayOfWeek: 1
    }, '保存课表配置失败');

    // 6. 收尾提示
    let message = `导入成功！共导入 ${courses.length} 门课程。`;
    if (startDate) message += `\n开学日期：${startDate}`;
    if (crawl.failedWeeks.length > 0) {
        message += `\n注意：第 ${crawl.failedWeeks.join('、')} 周抓取失败, 这些周的课程可能缺失。`;
    }
    if (pendingCourses.length > 0) {
        // 课程清单已经在导入前的弹窗里逐条列过了, 这里只留一句提醒
        message += `\n⚠️ 另有 ${pendingCourses.length} 门「时间地点待定」课程未导入课表, 请手动添加。`;
    }
    showToast(message);
    notifyTaskCompletion();
}

/* ============================ 入口 ============================ */

// 防重入: 用户连点两次导入、或脚本被重复注入时, 只让第一遍跑到底。
// 标志挂在 window 上才能跨「重复注入」共享; 这是运行期的并发守卫, 不是可配置的开关。
const NKU_RUNNING_FLAG = '__NKU_IMPORT_RUNNING__';

async function runImportFlow() {
    if (window[NKU_RUNNING_FLAG]) return;
    window[NKU_RUNNING_FLAG] = true;
    try {
        await importFlow();
    } finally {
        window[NKU_RUNNING_FLAG] = false;
    }
}

// 宿主（应用 / 测试插件）在用户点击「开始导入」后注入并执行本脚本, 因此顶层直接启动流程;
// 流程第一步就是向用户确认, 用户确认后才开始读取参数与抓取页面。
runImportFlow();

})();
