"""诊断 ST 前端状态。"""
import time
from playwright.sync_api import sync_playwright

ST_URL = "http://sillytavern:8000"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=["--no-sandbox", "--disable-gpu"])
    page = browser.new_page(viewport={"width": 1280, "height": 720})

    print("1. Loading ST...")
    page.goto(ST_URL + "/", timeout=30000)
    print("2. Page loaded, waiting 10s for init...")
    time.sleep(10)

    # Check title
    title = page.title()
    print(f"3. Title: {title}")

    # Check URL
    print(f"4. URL: {page.url}")

    # Check what globals exist
    print("5. Checking globals...")
    result = page.evaluate("""() => {
        const globals = {};
        globals.has_characters = typeof characters !== 'undefined';
        globals.has_oai_settings = typeof oai_settings !== 'undefined';
        globals.has_power_user = typeof power_user !== 'undefined';
        globals.has_main_api = typeof main_api !== 'undefined';
        globals.has_this_chid = typeof this_chid !== 'undefined';
        globals.has_Generate = typeof Generate !== 'undefined';
        globals.has_selectCharacterById = typeof selectCharacterById !== 'undefined';
        globals.has_saveSettingsDebounced = typeof saveSettingsDebounced !== 'undefined';
        globals.has_jQuery = typeof $ !== 'undefined';
        globals.has_toastr = typeof toastr !== 'undefined';
        globals.window_keys = Object.keys(window).filter(k => !k.startsWith('_') && !['document','location','navigator','history','screen','console'].includes(k)).slice(0, 50);
        return globals;
    }""")
    print(f"6. Globals: {result}")

    # Check for dialog/popup
    print("7. Checking for dialogs...")
    dialogs = page.evaluate("""() => {
        const dialogs = [];
        document.querySelectorAll('.dialog, .popup, .modal, [class*="dialog"], [class*="popup"]').forEach(d => {
            if (d.offsetWidth > 0) {
                dialogs.push({class: d.className, text: d.textContent?.slice(0, 200)});
            }
        });
        return dialogs;
    }""")
    print(f"8. Dialogs: {dialogs}")

    # Check character list
    print("9. Checking character list...")
    char_elements = page.evaluate("""() => {
        const chars = document.querySelectorAll('.character_select, [class*="character"]');
        return Array.from(chars).slice(0, 5).map(c => ({class: c.className, text: c.textContent?.slice(0, 100)}));
    }""")
    print(f"10. Character elements: {char_elements}")

    # Take screenshot
    page.screenshot(path="/tmp/st_diagnostic.png", full_page=True)
    print("11. Screenshot saved to /tmp/st_diagnostic.png")

    # Check page content
    body_text = page.evaluate("() => document.body.innerText.slice(0, 500)")
    print(f"12. Body text (first 500 chars): {body_text}")

    browser.close()
    print("13. Done")
