const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../douban-movie-exporter.user.js'), 'utf8');
const exposed = ['CONFIG', 'storageKey', 'getState', 'setState', 'getStoredData', 'setStoredData',
    'getSelectedFields', 'getCollectionScope', 'startScraping', 'processPage', 'parseBookPage',
    'parseMusicPage', 'parseGamePage', 'buildJsonOutput', 'getExportBaseName', 'buildWorkbook',
    'downloadCoversZip', 'createStoredZipBlob', 'utf8Bytes', 'crc32'];
const instrumented = source.replace(/\n    init\(\);\n\}\)\(\);\s*$/, `\n    globalThis.api = { ${exposed.join(', ')} };\n})();`);
assert.notEqual(instrumented, source);

function item(id, category = 'movie', title = `Title ${id}`) {
    return {
        querySelector(selector) {
            if (selector.includes('a[href')) return {
                href: `https://${category === 'game' ? 'www' : category}.douban.com/${category === 'game' ? 'game' : 'subject'}/${id}/`,
                textContent: title
            };
            if (selector === '.tags') return { textContent: '标签: 文学 科普' };
            if (selector === '.comment') return { textContent: '私人短评' };
            if (selector === '.date') return { textContent: '2026-10-01' };
            if (selector.startsWith('img[')) return {
                src: 'https://img1.doubanio.com/view/photo/s_ratio_poster/public/test.jpg',
                getAttribute: () => null
            };
            return null;
        },
        querySelectorAll: () => []
    };
}

function page({ href = 'https://movie.douban.com/people/alice/collect?mode=grid&start=0',
    category = 'movie', count = 1, currentPage = 1, totalPages = 1, totalRecords = null,
    next = '', session = new Map(), fetch, items, profileLink } = {}) {
    const queue = [];
    const storage = {
        getItem: key => session.get(key) ?? null,
        setItem: (key, value) => session.set(key, String(value)),
        removeItem: key => session.delete(key)
    };
    const rows = items || Array.from({ length: count }, (_, index) => item(String((currentPage - 1) * 15 + index + 1), category));
    const document = {
        querySelector(selector) {
            if (selector === '.paginator .thispage') return { textContent: String(currentPage) };
            if (selector === '.subject-num' && totalRecords !== null) return { textContent: `1-15 / ${totalRecords}` };
            if (selector === '.paginator .next a[href]' && next) return { href: next };
            if (selector === '.paginator a[href*="/people/"]' && profileLink) return { href: profileLink };
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.paginator .thispage, .paginator a') return [{ textContent: String(totalPages) }];
            if (selector.includes('.grid-view') || selector === '.subject-item' || selector === '.item.comment-item, .item' || selector === '.game-list .common-item') return rows;
            return [];
        },
        getElementById: () => ({}) // UI is checked separately with a browser; these tests exercise task/data behavior.
    };
    const context = vm.createContext({
        URL, URLSearchParams, TextEncoder, Blob, Uint8Array, Uint32Array, ArrayBuffer, DataView,
        crypto: { randomUUID }, location: new URL(href), window: {}, document, sessionStorage: storage,
        localStorage: { getItem() { throw new Error('Must not read website localStorage'); },
            setItem() { throw new Error('Must not write website localStorage'); } },
        setTimeout: callback => queue.push(callback),
        console: { error() {} },
        alert: message => { throw new Error(message); },
        fetch: fetch || (() => { throw new Error('Unexpected network request'); }),
        DOMParser: class { parseFromString() { return { querySelectorAll: () => [] }; } }
    });
    vm.runInContext(instrumented, context);
    return { api: context.api, context, session, queue, document,
        start: (fields = ['title'], covers = false, range = null) => context.api.startScraping(category, fields, covers, range),
        flush: async () => { while (queue.length) await queue.shift()(); } };
}

const plain = value => JSON.parse(JSON.stringify(value));

test('separate tabs do not share tasks or collected records', async () => {
    const alice = page();
    const bob = page({ href: 'https://movie.douban.com/people/bob/wish?mode=grid&start=0' });
    alice.start();
    assert.equal(bob.api.getState().status, 'idle');
    bob.start();
    await Promise.all([alice.flush(), bob.flush()]);
    assert.equal(alice.api.getStoredData().length, 1);
    assert.equal(bob.api.getStoredData().length, 1);
    assert.match(alice.api.getState().scope, /alice:collect$/);
    assert.match(bob.api.getState().scope, /bob:wish$/);
});

for (const target of ['https://movie.douban.com/people/bob/collect', 'https://movie.douban.com/people/alice/wish']) {
    test(`navigation to another collection cannot resume a task: ${target}`, async () => {
        const original = page();
        original.start();
        const other = page({ href: target, session: original.session });
        await other.api.processPage('movie', ['title']);
        assert.equal(other.queue.length, 0);
        assert.equal(other.api.getStoredData().length, 0);
    });
}

test('/mine uses the pagination owner across a canonical /people redirect', () => {
    const first = page({ href: 'https://movie.douban.com/mine?status=collect',
        profileLink: 'https://movie.douban.com/people/vanity/collect?start=15' });
    first.context.window._GLOBAL_NAV = { USER_ID: '123' };
    assert.equal(first.api.getCollectionScope('movie'),
        first.api.getCollectionScope('movie', 'https://movie.douban.com/people/vanity/collect?start=15'));
});

test('a two-page export keeps every record and finishes only on its final page', async () => {
    const first = page({ count: 15, totalPages: 2, totalRecords: 17,
        next: 'https://movie.douban.com/people/alice/collect?mode=grid&start=15' });
    first.start(['title', 'status']);
    await first.flush();
    assert.equal(first.api.getState().status, 'running');
    assert.equal(first.api.getState().nextPage, 2);
    const second = page({ href: first.context.location.href, count: 2, currentPage: 2,
        totalPages: 2, totalRecords: 17, session: first.session });
    await second.api.processPage('movie', second.api.getSelectedFields());
    await second.flush();
    assert.equal(second.api.getState().status, 'paused_for_download');
    assert.equal(second.api.getStoredData().length, 17);
    assert.equal(second.api.buildJsonOutput('movie').meta.complete, true);
});

test('a selected page range completes without following the next link', async () => {
    const p = page({ href: 'https://movie.douban.com/people/alice/collect?mode=grid&start=15',
        currentPage: 2, count: 15, totalPages: 3, totalRecords: 40,
        next: 'https://movie.douban.com/people/alice/collect?mode=grid&start=30' });
    p.start(['title'], false, { startPage: 2, endPage: 2 });
    await p.flush();
    assert.equal(p.api.getState().status, 'paused_for_download');
    assert.equal(p.api.getStoredData().length, 15);
});

for (const [name, options] of [
    ['unrecognized empty page', { count: 0 }],
    ['missing next link', { count: 15, totalPages: 2 }],
    ['short intermediate page', { count: 14, totalPages: 2 }],
    ['short final page with a known total', { count: 1, totalRecords: 2 }],
    ['missing pagination with a known larger total', { count: 15, totalRecords: 30 }],
    ['duplicate rows', { count: 2, items: [item('1'), item('1')] }],
    ['missing item ID', { items: [item('invalid')] }],
    ['missing title', { items: [item('1', 'movie', '')] }],
    ['skipped next page', { count: 15, totalPages: 3, next: 'https://movie.douban.com/people/alice/collect?start=30' }],
    ['next page belongs to another user', { count: 15, totalPages: 2, next: 'https://movie.douban.com/people/bob/collect?start=15' }]
]) {
    test(`${name} produces an incomplete result instead of success`, async () => {
        const p = page(options);
        p.start();
        await p.flush();
        assert.equal(p.api.getState().status, 'error');
        assert.equal(p.api.buildJsonOutput('movie').meta.complete, false);
        assert.match(p.api.getExportBaseName('movie'), /_Partial_/);
    });
}

test('a failed later page preserves earlier validated records', async () => {
    const first = page({ count: 15, totalPages: 2, totalRecords: 16,
        next: 'https://movie.douban.com/people/alice/collect?start=15' });
    first.start();
    await first.flush();
    const broken = page({ href: first.context.location.href, count: 0, currentPage: 2,
        totalPages: 2, totalRecords: 16, session: first.session });
    await broken.api.processPage('movie', ['title']);
    await broken.flush();
    assert.equal(broken.api.getState().status, 'error');
    assert.equal(broken.api.getStoredData().length, 15);
});

test('superseded delayed callbacks cannot finish a replacement task', async () => {
    const p = page();
    p.start(['title']);
    const oldId = p.api.getState().taskId;
    p.start(['title', 'date']);
    assert.notEqual(p.api.getState().taskId, oldId);
    await p.flush();
    assert.equal(p.api.getState().status, 'paused_for_download');
    assert.equal(p.api.getStoredData()[0].date, '2026-10-01');
});

test('a superseded async fetch cannot replace the new task with an error', async () => {
    let rejectFetch;
    const p = page({ fetch: () => new Promise((resolve, reject) => { rejectFetch = reject; }) });
    p.start(['title', 'comment']);
    const pending = p.queue.shift()();
    p.start(['title']);
    const newId = p.api.getState().taskId;
    rejectFetch(new Error('Old request failed'));
    await pending;
    assert.equal(p.api.getState().taskId, newId);
    assert.equal(p.api.getState().status, 'running');
    await p.flush();
    assert.equal(p.api.getState().status, 'paused_for_download');
});

for (const category of ['book', 'music', 'game']) {
    test(`${category} retains tags displayed in the collection item`, () => {
        const p = page({ category });
        const parse = p.api[`parse${category[0].toUpperCase()}${category.slice(1)}Page`];
        assert.equal(parse()[0].tags, '文学 科普');
    });
}

test('unselected personal fields and cover URLs are never persisted', async () => {
    const p = page();
    p.start(['title']);
    await p.flush();
    assert.deepEqual(Object.keys(p.api.getStoredData()[0]).sort(), ['category', 'id', 'link', 'title']);
    assert.deepEqual(plain(p.api.buildJsonOutput('movie').items), [{ title: 'Title 1' }]);
});

test('selecting covers does not retain unselected comments or manifest details', async () => {
    const p = page();
    p.start([], true);
    await p.flush();
    const stored = p.api.getStoredData()[0];
    assert.equal(stored.comment, undefined);
    assert.equal(stored.title, undefined);
    assert.equal(stored.rating, undefined);
    assert.match(stored.cover_url, /^https:\/\/img1\.doubanio\.com\//);
    assert.match(p.api.buildJsonOutput('movie').items[0].cover_file, /^covers\//);
});

for (const [name, fetch] of [
    ['HTTP failure', async () => ({ ok: false, status: 403 })],
    ['login/verification HTML', async () => ({ ok: true, text: async () => '<html>Login required</html>' })]
]) {
    test(`movie detail ${name} cannot silently drop requested comments`, async () => {
        const p = page({ fetch });
        p.start(['title', 'comment']);
        await p.flush();
        assert.equal(p.api.getState().status, 'error');
        assert.match(p.api.getState().message, /无法补充电影/);
    });
}

test('a valid movie list response preserves selected comments and tags', async () => {
    const p = page({ fetch: async () => ({ ok: true, text: async () => '<div class="list-view"></div>' }) });
    p.context.DOMParser = class {
        parseFromString() { return { querySelectorAll: () => [item('1')] }; }
    };
    p.start(['title', 'comment', 'tags']);
    await p.flush();
    assert.equal(p.api.getState().status, 'paused_for_download');
    assert.equal(p.api.getStoredData()[0].comment, '私人短评');
    assert.equal(p.api.getStoredData()[0].tags, '文学 科普');
});

test('cover downloads cannot package data from a replacement task', async () => {
    const p = page();
    p.start([], true);
    await p.flush();
    let finishRequest;
    p.context.GM_xmlhttpRequest = options => { finishRequest = options.onload; };
    const pending = p.api.downloadCoversZip('movie', null, null);
    p.start(['title']);
    await finishRequest({ status: 200, response: new Uint8Array([137, 80, 78, 71]).buffer });
    await assert.rejects(pending, /导出任务已变化/);
});

test('export metadata, filename, and worksheet use the task status', async () => {
    const p = page();
    p.start(['title']);
    await p.flush();
    p.context.location = new URL('https://movie.douban.com/people/alice/wish');
    let sheetName;
    p.context.XLSX = { utils: {
        aoa_to_sheet: () => ({}), book_new: () => ({}),
        book_append_sheet: (wb, ws, name) => { sheetName = name; }
    } };
    p.api.buildWorkbook('movie');
    assert.equal(sheetName, '电影收藏（看过）');
    assert.equal(p.api.buildJsonOutput('movie').meta.category_name, '电影（看过）');
    assert.match(p.api.getExportBaseName('movie'), /Movie_Collect_/);
});

test('ZIP checksum and archive generation remain valid', async () => {
    const p = page();
    const bytes = p.api.utf8Bytes('123456789');
    assert.equal(p.api.crc32(bytes), 0xcbf43926);
    const zip = await p.api.createStoredZipBlob([
        { path: 'covers/中文.txt', bytes, crc: p.api.crc32(bytes) }
    ], '{"ok":true}', null, null);
    const archive = Buffer.from(await zip.arrayBuffer());
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.equal(archive.readUInt16LE(archive.length - 14), 2);
    assert.ok(archive.includes(Buffer.from('covers/中文.txt')));
});
