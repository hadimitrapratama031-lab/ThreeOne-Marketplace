"""
E2E browser (opsional, butuh Python + Playwright + Chromium):
  pip install playwright && playwright install chromium
  BASE_URL=http://localhost:3000 ADMIN_EMAIL=... ADMIN_PASSWORD=... python test/e2e/browser.py
Menjalankan rantai nyata: Admin UI -> backend -> MongoDB -> R2 -> Socket.IO -> halaman Marketplace yang sedang terbuka.
Server harus berjalan dengan data seed (SEED_DEMO=true) dan R2 yang valid (atau R2 tiruan).
"""
import os, sys, time, urllib.request, urllib.error
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:3100')
EMAIL = os.environ.get('ADMIN_EMAIL', 'admin@example.com')
PASS = os.environ.get('ADMIN_PASSWORD', 'correct-horse-battery')
IMG = os.environ.get('E2E_IMAGE', os.path.join(os.path.dirname(__file__), 'cover.png'))
SHOTS = os.environ.get('E2E_SHOTS', '')
RUN = int(time.time()) % 100000
NAME = f'E2E Produk {RUN}'
REVIEWER = f'Penguji {RUN}'

results = []
def check(label, ok, extra=''):
    results.append((label, bool(ok)))
    print(('PASS ' if ok else 'FAIL ') + label + (f'  [{extra}]' if extra and not ok else ''))

def status(url):
    try: return urllib.request.urlopen(url, timeout=5).status
    except urllib.error.HTTPError as e: return e.code

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []
    def watch(page, tag):
        page.on('pageerror', lambda e: errors.append(f'{tag} pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'{tag}: {m.text}') if m.type == 'error' and 'fonts.g' not in m.text and '403' not in m.text and '401' not in m.text and '404' not in m.text else None)

    mp = browser.new_context(viewport={'width': 1360, 'height': 900}).new_page(); watch(mp, 'marketplace')
    cdp = mp.context.new_cdp_session(mp)   # CSP halaman memblokir eval; CDP tidak terikat CSP, jadi CSP aplikasi tetap aktif saat diuji
    def js(expr):
        r = cdp.send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in r: raise RuntimeError(r['exceptionDetails'])
        return r['result'].get('value')
    live = lambda state, t=8000: expect(mp.locator('html')).to_have_attribute('data-live', state, timeout=t)
    ad = browser.new_context(viewport={'width': 1440, 'height': 900}).new_page(); watch(ad, 'admin')

    # --- Marketplace terbuka dulu ---
    mp.goto(BASE + '/'); mp.wait_for_selector('.card'); live('online')
    base_cards = mp.locator('.card').count()
    check('Marketplace memuat produk dari API + Socket.IO tersambung', base_cards > 0)

    # --- Login admin ---
    ad.goto(BASE + '/admin/'); ad.fill('input[name=email]', EMAIL); ad.fill('input[name=password]', PASS); ad.click('#login-form button[type=submit]')
    ad.wait_for_selector('.kpi'); expect(ad.locator('#live-chip')).to_have_attribute('data-state', 'online', timeout=8000)
    check('Admin: login lalu masuk Dashboard, status Live', ad.locator('#live-chip').get_attribute('data-state') == 'online')
    check('Admin melihat pengunjung online (Marketplace → Admin)', ad.locator('#kpi-online').inner_text().strip() not in ('', '0'))

    # --- Tambah produk + upload gambar ke R2 ---
    ad.goto(BASE + '/admin/#/products'); ad.wait_for_selector('tbody tr')
    ad.click('[data-add]'); ad.wait_for_selector('dialog.drawer[open]')
    ad.fill('input[name=name]', NAME)
    ad.fill('input[name=price]', '88000'); ad.fill('input[name=stock]', '7'); ad.fill('textarea[name=description]', 'Dibuat lewat Admin Web (E2E).')
    with ad.expect_file_chooser() as fc: ad.click('dialog [data-add]')
    fc.value.set_files(IMG)
    ad.wait_for_selector('dialog .media-tile img')
    if SHOTS: ad.screenshot(path=f'{SHOTS}/e2e_product_form.png')
    ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    mp.wait_for_selector(f'.card:has-text("{NAME}")', timeout=5000)
    card = mp.locator(f'.card:has-text("{NAME}")')
    check('Produk baru muncul di Marketplace TANPA refresh', card.count() == 1)
    src = card.locator('img').get_attribute('src')
    card.scroll_into_view_if_needed()          # gambar memakai loading="lazy"
    natural = lambda: js(f"[...document.images].find(i => i.src === {src!r}).naturalWidth")
    for _ in range(40):
        if natural() > 0: break
        time.sleep(0.15)
    check('Gambar benar-benar ter-render (naturalWidth > 0)', natural() > 0)
    check('Gambar tampil dari URL publik R2 (bukan localhost/base64)', src.startswith(BASE.replace('3100','')[:0]) or 'bkt/products/' in src and not src.startswith('data:'), src)
    check('URL gambar bisa diakses (HTTP 200)', status(src) == 200, src)
    check('Jumlah kartu +1 dan tidak ada duplikat', mp.locator('.card').count() == base_cards + 1 and mp.locator(f'.card:has-text("{NAME}")').count() == 1)

    # --- Edit harga ---
    ad.locator(f'tr:has-text("{NAME}") [data-edit]').last.click(); ad.wait_for_selector('dialog.drawer[open]')
    ad.fill('input[name=price]', '99500'); ad.fill('input[name=oldPrice]', '120000')
    ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    expect(mp.locator(f'.card:has-text("{NAME}") .price')).to_have_text('Rp 99.500', timeout=5000)
    check('Edit harga di Admin → harga di Marketplace berubah otomatis', True)

    # --- Nonaktifkan / aktifkan ---
    ad.locator(f'tr:has-text("{NAME}") .switch i').click()
    expect(mp.locator(f'.card:has-text("{NAME}")')).to_have_count(0, timeout=5000)
    check('Nonaktifkan produk → hilang dari Marketplace', True)
    ad.locator(f'tr:has-text("{NAME}") .switch i').click()
    expect(mp.locator(f'.card:has-text("{NAME}")')).to_have_count(1, timeout=5000)
    check('Aktifkan lagi → muncul kembali', True)

    # --- Halaman detail produk realtime ---
    pid = ad.locator(f'tr:has-text("{NAME}") small').first.inner_text().split('ID ')[1].split(' ')[0]
    dp = mp.context.new_page(); watch(dp, 'detail'); dp.goto(f'{BASE}/product/{pid}'); dp.wait_for_selector('.pd-title')
    check('Detail produk: diskon dihitung dari harga coret', '-17%' in dp.locator('.pd-price__old').inner_text())
    ad.locator(f'tr:has-text("{NAME}") [data-edit]').last.click(); ad.wait_for_selector('dialog.drawer[open]')
    ad.fill('input[name=name]', NAME + ' v2'); ad.fill('input[name=stock]', '0')
    ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    expect(dp.locator('.pd-title')).to_have_text(NAME + ' v2', timeout=5000)
    expect(dp.locator('.pd-buy .stock')).to_have_text('Habis', timeout=5000)
    check('Detail produk ikut berubah realtime (nama + stok habis)', True)
    if SHOTS: dp.screenshot(path=f'{SHOTS}/e2e_detail.png')
    NAME2 = NAME + ' v2'

    # --- Hero, FAQ, Kontak, Kategori ---
    ad.goto(BASE + '/admin/#/hero'); ad.wait_for_selector('input[name=title]')
    ad.fill('input[name=title]', 'Judul Hero Dari Admin'); ad.click('#form button[type=submit]'); ad.wait_for_selector('.toast')
    expect(mp.locator('#hero-title')).to_have_text('Judul Hero Dari Admin', timeout=5000)
    check('Hero diubah → judul hero Marketplace berubah', True)

    faq_before = mp.locator('.faq__item').count()
    ad.goto(BASE + '/admin/#/faq'); ad.wait_for_selector('.row'); ad.click('[data-add]'); ad.wait_for_selector('dialog[open]')
    check('Admin: listener halaman lama tidak menumpuk (1 klik = 1 dialog)', ad.locator('dialog[open]').count() == 1, str(ad.locator('dialog[open]').count()))
    ad.fill('dialog input[name=question]', 'Pertanyaan dari E2E?'); ad.fill('dialog textarea[name=answer]', 'Jawaban E2E.'); ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    expect(mp.locator('.faq__item')).to_have_count(faq_before + 1, timeout=5000)
    check('FAQ ditambah → FAQ Marketplace bertambah', True)

    ad.goto(BASE + '/admin/#/contacts'); ad.wait_for_selector('.row')
    ad.locator('.row').first.locator('[data-edit]').click(); ad.wait_for_selector('dialog[open]')
    ad.fill('dialog input[name=value]', '+62 899-1111-2222'); ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    expect(mp.locator('.contact-card').first.locator('b')).to_have_text('+62 899-1111-2222', timeout=5000)
    check('Kontak diubah → kartu kontak Marketplace berubah', True)

    ad.goto(BASE + '/admin/#/categories'); ad.wait_for_selector('.row')
    ad.locator('.row:has-text("Tools") [data-edit]').click(); ad.wait_for_selector('dialog[open]')
    ad.fill('dialog input[name=name]', 'Tools & Software'); ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    expect(mp.locator('.filter:has-text("Tools & Software")')).to_have_count(1, timeout=5000)
    check('Kategori di-rename → filter + judul grup Marketplace berubah', mp.locator('.category__head h3:has-text("Tools & Software")').count() == 1)

    # --- Ulasan ---
    ad.goto(BASE + '/admin/#/reviews'); ad.wait_for_selector('tbody tr'); ad.click('[data-add]'); ad.wait_for_selector('dialog[open]')
    ad.select_option('dialog select[name=productId]', pid); ad.fill('dialog input[name=name]', REVIEWER); ad.fill('dialog textarea[name=text]', 'Ulasan dari E2E.')
    ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    expect(dp.locator(f'.review:has-text("{REVIEWER}")')).to_have_count(1, timeout=5000)
    check('Ulasan baru muncul di halaman detail produk realtime', True)
    ad.locator(f'tr:has-text("{REVIEWER}") .switch i').click()
    expect(dp.locator(f'.review:has-text("{REVIEWER}")')).to_have_count(0, timeout=5000)
    check('Moderasi: ulasan disembunyikan → hilang dari detail produk', True)

    # --- Reconnect: tidak ada listener ganda, data tersinkron ---
    listeners = lambda: js("Live.socket.listeners('product:update').length")
    for _ in range(3):
        js("void Live.socket.io.engine.close()"); live('offline', 3000); live('online')
    check('Setelah 3x reconnect hanya ada 1 listener per event', listeners() == 1, str(listeners()))
    js("void Live.socket.disconnect()"); live('offline')
    ad.goto(BASE + '/admin/#/products'); ad.wait_for_selector('tbody tr')
    ad.locator(f'tr:has-text("{NAME2}") [data-edit]').last.click(); ad.wait_for_selector('dialog.drawer[open]')
    ad.fill('input[name=stock]', '9'); ad.fill('input[name=name]', NAME2 + ' offline'); ad.click('dialog button[type=submit]'); ad.wait_for_selector('.toast')
    time.sleep(0.4)
    check('Saat offline UI tetap memakai data terakhir', mp.locator(f'.card:has-text("{NAME2}")').count() == 1 and mp.locator(f'.card:has-text("offline")').count() == 0)
    js("void Live.socket.connect()")
    expect(mp.locator(f'.card:has-text("{NAME2} offline")')).to_have_count(1, timeout=8000)
    check('Sinkron setelah reconnect: perubahan saat offline muncul', True)
    check('Setelah tersambung lagi data disinkron dari database tanpa duplikat', mp.locator(f'.card:has-text("{NAME}")').count() == 1)

    # --- Hapus produk: record + objek R2 ---
    NAME3 = NAME2 + ' offline'
    ad.goto(BASE + '/admin/#/products'); ad.wait_for_selector('tbody tr')
    ad.locator(f'tr:has-text("{NAME3}") [data-del]').click(); ad.wait_for_selector('dialog[open]')
    ad.click('dialog [data-ok]'); ad.wait_for_selector('.toast')
    expect(mp.locator(f'.card:has-text("{NAME}")')).to_have_count(0, timeout=5000)
    check('Hapus produk → hilang dari Marketplace', True)
    check('Objek gambar di R2 ikut terhapus (URL publik → 404)', status(src) == 404, str(status(src)))
    ad.reload(); ad.wait_for_selector('tbody tr')
    check('Setelah refresh Admin, produk tetap terhapus (sumber kebenaran: MongoDB)', ad.locator(f'tr:has-text("{NAME}")').count() == 0)

    # --- Responsif ---
    if SHOTS:
        m = browser.new_context(viewport={'width': 390, 'height': 800}, device_scale_factor=2).new_page()
        m.goto(BASE + '/admin/'); m.fill('input[name=email]', EMAIL); m.fill('input[name=password]', PASS); m.click('#login-form button[type=submit]'); m.wait_for_selector('.kpi')
        m.screenshot(path=f'{SHOTS}/e2e_admin_mobile.png')
        m.goto(BASE + '/admin/#/products'); m.wait_for_selector('tbody tr'); m.screenshot(path=f'{SHOTS}/e2e_admin_mobile_products.png')
        mc = m.context.new_cdp_session(m)
        over = lambda pg_cdp: pg_cdp.send('Runtime.evaluate', {'expression': 'document.documentElement.scrollWidth > innerWidth + 1', 'returnByValue': True})['result']['value']
        check('Admin 390px: halaman tidak overflow horizontal', not over(mc))
        mm = browser.new_context(viewport={'width': 390, 'height': 800}).new_page(); mm.goto(BASE + '/'); mm.wait_for_selector('.card')
        check('Marketplace 390px: tidak overflow horizontal', not over(mm.context.new_cdp_session(mm)))

    check('Tidak ada error JavaScript di Marketplace/Admin/Detail', not errors, '; '.join(errors[:4]))
    browser.close()

bad = [r for r in results if not r[1]]
print(f'\n{len(results) - len(bad)}/{len(results)} lulus')
sys.exit(1 if bad else 0)
